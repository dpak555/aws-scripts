
'use strict';

var RateLimiter = require('limiter').RateLimiter;
// Allow 2 requests per second. Also understands
// 'second', 'minute', 'day', or a number of milliseconds
var limiter = new RateLimiter(2, 'second');

const util = require('util');
const _ = require('lodash');
const async = require('async');
const fs = require('fs');
const moment = require('moment');
const jsonfile = require('jsonfile');
var AWS = require('aws-sdk');
AWS.config.loadFromPath('./config.json');
const statefile = './snapshots-pending-delete.json';

var ec2 = new AWS.EC2();

var activeSourceSnapshots = new Set();
var orphanCollector = new Set();
var orphanCollectorArr = [];
var sourceSnapshotDetail = [];
var sourceVolumeDetail = [];
var pitSnapshotsCollectorArr = [];
var deletablePitSnapshots = [];
var excludedByDND = [];

function saveState(state) {
  jsonfile.writeFile(statefile, state, function (err) {
    if (err) console.error(err);
  })
}

function loadState() {
  var deletables = [];
  if (fs.existsSync(statefile)) {
    deletables = jsonfile.readFileSync(statefile);
  }
  return deletables;
}

function deleteBy(deleteByArr, deleteArr, deleteArrKey, deleteByKey) {
  var delidx
  for (delidx = deleteByArr.length - 1; delidx >= 0; delidx--) {
    deleteArr.splice(_.findIndex(deleteArr, function (item) {
      return item[deleteArrKey] === deleteByArr[delidx][deleteByKey];
    }), 1);
  }
  return deleteArr;
}

async.parallel({
    Volumes: function(callback) {

      // acquire in-use volumes
      var paramsDescVol = {};
      ec2.describeVolumes(paramsDescVol, function(err, data) {
        if (err) console.log(err, err.stack); // an error occurred
        else {
          callback(null, data);
        }
      });
    },

    Snapshots: function(callback) {

      // acquire my completed snapshots
      var paramsDescSnap = {
        Filters: [
          {
            Name: "status", 
            Values: [
              "completed"
            ]
          }
        ],
        OwnerIds: [
          "XXXXXXXXXXXX"
        ]
      };

      ec2.describeSnapshots(paramsDescSnap, function(err, data) {
        if (err) console.log(err, err.stack); // an error occurred
        else {
          callback(null, data);
        }
      });
    }
},
function(err, results) {

// RAW OUTPUT FOR DEBUGGING
//  console.log(util.inspect(results.Volumes.Volumes, {showHidden: false, depth: null}));
//  console.log(util.inspect(results.Snapshots.Snapshots, {showHidden: false, depth: null}));

  // iterate snapshots
  _.forEach(results.Snapshots.Snapshots, function(snapshot) {

    var vol_match = false;
    var snap_match = false;

    // collect Do Not Delete (DND) tags for later exclusion
    if (_.find(snapshot.Tags, { 'Key': 'DND', 'Value': 'true' })) {
      excludedByDND.push(snapshot.SnapshotId);
    }

    // iterate volumes for each snapshot
    _.forEach(results.Volumes.Volumes, function(volume) {

      // see if the source volume exists; stop chaecking if a match is found
      // (there will be 0 or 1 matches)
      if (!vol_match && snapshot.VolumeId == volume.VolumeId) {
        vol_match = true;

        var volObject = {};
        volObject.SnapshotId = snapshot.SnapshotId;
        volObject.VolumeId = volume.VolumeId;
        sourceVolumeDetail.push(volObject);
      }

      // find existing volumes to which this snapshot has given rise to
      if (snapshot.SnapshotId == volume.SnapshotId) {
        
        // save this snapshot id to the exclusion list for chrono snapshot wipe
        // (we don't delete snapshots that have given rise to one or more existing volumes)
        activeSourceSnapshots.add(snapshot.SnapshotId);

        // store the volume-to-snapshot reference for reporting/display purposes        
        var localObject = {};
        localObject.SnapshotId = snapshot.SnapshotId;
        localObject.volumes = [ volume.VolumeId ];

        // extend existing volumes array if an entry exists for a snapshot already
        if (_.find(sourceSnapshotDetail, { SnapshotId: snapshot.SnapshotId })) {
          localObject.volumes = _.union(localObject.volumes, _.find(sourceSnapshotDetail, { 'SnapshotId': snapshot.SnapshotId  }).volumes);
          _.extend(_.find(sourceSnapshotDetail, { SnapshotId: snapshot.SnapshotId }), localObject);
        }
        else {
          // .. otherwise just add a new object (this is the first snapshot found for the volume)
          sourceSnapshotDetail.push(localObject);
        }
        
        // at least one snapshot was found
        snap_match = true;
      }

    });

    if (!vol_match && !snap_match) {
      // This is an orphan snapshot (no source, no destination), and must be deleted!
      orphanCollector.add(snapshot.SnapshotId);
    }
    
  });

  // array of snapshots that give rise to one or more existing volumes
  var activeSourceSnapshotsArr = Array.from(activeSourceSnapshots);
  activeSourceSnapshots = '';

  // array of orphan snapshots (these are deletable as-is)
  orphanCollectorArr = Array.from(orphanCollector);
  orphanCollector = '';

  // iterate volumes to find all point-in-time snapshots for each volume
  _.forEach(results.Volumes.Volumes, function(volume) {
  
    var pitSnapshotsCollector = new Set();
    // iterate snapshots for each volume; save found matches
    _.forEach(results.Snapshots.Snapshots, function(snapshot) {
      if (snapshot.VolumeId == volume.VolumeId) {
        
        var localObject = new Object();
        localObject.SnapshotId = snapshot.SnapshotId;
        localObject.StartTime = snapshot.StartTime;
        
        pitSnapshotsCollector.add(localObject);
      }
    });
    pitSnapshotsCollectorArr = Array.from(pitSnapshotsCollector);
    pitSnapshotsCollector = '';

    // sort the point-in-time snapshots for the volume, the most recent first
    pitSnapshotsCollectorArr.sort(function(a,b) {
      return new Date(b.StartTime) - new Date(a.StartTime);
    });

    // if more than one snapshot exist for a volume
    // remove all but the most recent one
    // (the snapshots left in the array will be deleted)
    if (pitSnapshotsCollectorArr.length > 1) {
      pitSnapshotsCollectorArr.shift();
    }

    // save the SnapshotId's only (drop the times), convert to an array
    for (var o in pitSnapshotsCollectorArr) {
      if (pitSnapshotsCollectorArr[o].SnapshotId != '') {
        deletablePitSnapshots.push(pitSnapshotsCollectorArr[o].SnapshotId);
      }
    }

  });

  // exclude snapshots that have given rise to existing volumes
  var actuallyDeletablePitSnapshots = _.difference(deletablePitSnapshots, activeSourceSnapshotsArr);

  // exclude snapshots marked explicitly to be saved with "DND:true" tag
  actuallyDeletablePitSnapshots = _.difference(actuallyDeletablePitSnapshots, excludedByDND);
  orphanCollectorArr = _.difference(orphanCollectorArr, excludedByDND);

  // make sure there are no duplicates (to prevent errors at deletion time)
  deletablePitSnapshots = _.uniq(deletablePitSnapshots);
  activeSourceSnapshotsArr = _.uniq(activeSourceSnapshotsArr);
  actuallyDeletablePitSnapshots = _.uniq(actuallyDeletablePitSnapshots);
  orphanCollectorArr = _.uniq(orphanCollectorArr);

  // load prior/pending deletables (state file)
  var priorDeletables = loadState();

  // exclude from saved state any snapshots that have been marked "DND:true" since the state was written
  priorDeletables = priorDeletables.filter(function(el) {
    return excludedByDND.indexOf(el.SnapshotId) === -1;
  });
  // then compact the array as any deletions don't change the array length (i.e. "..item,,item..")
  priorDeletables = _.compact(priorDeletables);

  console.log('ALL DELETABLE POINT-IN-TIME SNAPSHOTS (' + deletablePitSnapshots.length + '):\n' + util.inspect(deletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');  
  console.log('THESE SOURCE SNAPSHOTS (' + activeSourceSnapshotsArr.length + ') ARE EXCLUDED FROM OTHERWISE DELETABLE POINT-IN-TIME SNAPSHOTS (if a corresponding and current PIT snapshot exists):\n' + util.inspect(activeSourceSnapshotsArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('**NOTE: all point-in-time snapshots less exclusions is NOT equal to the number of actually deletable snapshots, because for many source snapshots their source no longer exists, and hence they\'re not on the PIT list anyway! DND exclusions may also affect the final number of deletable PIT snapshots.\n');
  console.log('DELETABLE POINT-IN-TIME SNAPSHOTS AFTER EXCLUSIONS (' + actuallyDeletablePitSnapshots.length + '):\n' + util.inspect(actuallyDeletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('ORPHANS (' + orphanCollectorArr.length + ') TO BE DELETED (WITH DNDs EXCLUDED):\n' + util.inspect(orphanCollectorArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SOURCE SNAPSHOT DETAIL (KEEPING):\n' + util.inspect(sourceSnapshotDetail, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SOURCE VOLUME DETAIL (KEEPING):\n' + util.inspect(sourceVolumeDetail, {showHidden: false, depth: null}));
  console.log('\n');

  // combine remaining deletable PIT snapshots and orphans
  var allCurrentlyDeletableSnapshots = _.union(actuallyDeletablePitSnapshots, orphanCollectorArr);
  
  console.log('ALL CURRENTLY DELETABLE SNAPSHOTS (' + allCurrentlyDeletableSnapshots.length + '):\n' + util.inspect(allCurrentlyDeletableSnapshots, {showHidden: false, depth: null}));
  console.log('\n');

  // remove all snapshots previously marked for deletion from the current list
  allCurrentlyDeletableSnapshots = deleteBy(priorDeletables, allCurrentlyDeletableSnapshots, 'SnapshotId', 'SnapshotId');

  console.log('CURRENT LIST AFTER SAVED STATE HAS BEEN DELETED: ' + util.inspect(allCurrentlyDeletableSnapshots, {showHidden: false, depth: null}));

  // create pending delete object to add to the state
  var pendingDelete = [];
  var deleteObj = {};
  var deletionTime = moment().add(1, 'week').unix();
  
  for (var s of allCurrentlyDeletableSnapshots) {
    deleteObj = { 'SnapshotId': s, 'DeletionTime': deletionTime };
    pendingDelete.push(deleteObj);
  }  

  // combine state with the new deletable snapshots
  var newState = _.union(priorDeletables, pendingDelete);

  console.log('now saving the previous state plus ' + pendingDelete.length + ' new items');

  // save/persist state
  saveState(newState);

  console.log('NEW STATE:\n');
  console.log(util.inspect(newState, {showHidden: false, depth: null}));
  
});
