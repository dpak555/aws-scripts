
'use strict';

const OwnerIDs = [ 'XXXXXXXXXXXX' ];

const util = require('util');
const _ = require('lodash');
const async = require('async');
const fs = require('fs');
const moment = require('moment');
const jsonfile = require('jsonfile');
var AWS = require('aws-sdk');
AWS.config.loadFromPath('./config.json');
const snapStateFile = './snapshots-pending-delete.json';
const volStateFile = './volumes-pending-delete.json';

var ec2 = new AWS.EC2();
var deletionTime = moment().add(1, 'week').unix();
var deleteObj = {};

var activeSourceSnapshots = new Set();
var orphanSnapCollector = new Set();
var orphanSnapCollectorArr = [];
var sourceSnapshotDetail = [];
var sourceVolumeDetail = [];
var pitSnapshotsCollectorArr = [];
var deletablePitSnapshots = [];
var snapsExcludedByDND = [];
var delVolCollector = [];
var volsExcludedByDND = [];

// save persisted state into a file
function saveState(state, stateFile) {
  jsonfile.writeFile(stateFile, state, function (err) {
    if (err) console.error(err);
  })
}

// read persisted state from a file (check if it exists first)
function loadState(stateFile) {
  var deletables = [];
  if (fs.existsSync(stateFile)) {
    try {
      deletables = jsonfile.readFileSync(stateFile);
    }
    // ignore errors; just return an empty array, and the new state will overwrite it
    catch (e) {}
  }
  return deletables;
}

// delete items/objects in an array by properties of another array
function deleteBy(deleteByArr, deleteArr, deleteArrKey, deleteByKey, deltype) {
  var delidx
  for (delidx = deleteByArr.length - 1; delidx >= 0; delidx--) {
    deleteArr.splice(_.findIndex(deleteArr, function(item) {
      if (deltype == 'delby2delarr1') {
        return item === deleteByArr[delidx][deleteByKey];
      }
      else if (deltype == 'delby1delarr2') {
        return item[deleteArrKey] === deleteByArr[delidx];
      }
    }), 1);
  }
  return deleteArr;
}

async.parallel({
  Volumes: function(callback) {

    // acquire in-use and available (detached) volumes
    // (do not select volumes that are being created or deleted)
    var paramsDescVol = {
      Filters: [
        {
          Name: 'status',
          Values: [ 'available', 'in-use' ]
        }
      ]    
    };
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
          Name: 'status', 
          Values: [
            'completed'
          ]
        }
      ],
      OwnerIds: OwnerIDs
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

  // ITERATE SNAPSHOTS
  _.forEach(results.Snapshots.Snapshots, function(snapshot) {

    var vol_match = false;
    var snap_match = false;

    // collect Do Not Delete (DND) tags for later exclusion
    if (_.find(snapshot.Tags, { 'Key': 'DND', 'Value': 'true' })) {
      snapsExcludedByDND.push(snapshot.SnapshotId);
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
      orphanSnapCollector.add(snapshot.SnapshotId);
    }
    
  });

  // array of snapshots that give rise to one or more existing volumes
  var activeSourceSnapshotsArr = Array.from(activeSourceSnapshots);
  activeSourceSnapshots = '';

  // array of orphan snapshots (these are deletable as-is)
  orphanSnapCollectorArr = Array.from(orphanSnapCollector);
  orphanSnapCollector = '';

  // do not consider detached volumes younger than 2 days for deletion
  var volSelectTimeLimiter = moment().subtract(2, 'days').unix();

  // ITERATE VOLUMES to create a list of detached volumes tagged for deletion,
  // and to find all point-in-time snapshots for each volume
  // (if a volume is slated for deletion, its PIT snapshots will be deleted in
  // the following cycle)
  _.forEach(results.Volumes.Volumes, function(volume) {

    var volCreateTimeStamp = moment(volume.CreateTime).unix();
    // select available (detached) volumes created more than 2 days ago
    if (volume.State == 'available' && volSelectTimeLimiter > volCreateTimeStamp) {

      // check if volume that otherwise would be deletable is excluded by a DND tag
      if (_.find(volume.Tags, { 'Key': 'DND', 'Value': 'true' })) {
        volsExcludedByDND.push(volume.VolumeId);
      }
      // .. otherwise include the volume on the deletion list
      else {
        delVolCollector.push(volume.VolumeId);
      }
    }
    
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
  actuallyDeletablePitSnapshots = _.difference(actuallyDeletablePitSnapshots, snapsExcludedByDND);
  orphanSnapCollectorArr = _.difference(orphanSnapCollectorArr, snapsExcludedByDND);

  // make sure there are no duplicates (to prevent errors at deletion time)
  deletablePitSnapshots = _.uniq(deletablePitSnapshots);
  activeSourceSnapshotsArr = _.uniq(activeSourceSnapshotsArr);
  actuallyDeletablePitSnapshots = _.uniq(actuallyDeletablePitSnapshots);
  orphanSnapCollectorArr = _.uniq(orphanSnapCollectorArr);

  // combine remaining deletable PIT snapshots and orphans
  var currentlyDeletableSnaps = _.union(actuallyDeletablePitSnapshots, orphanSnapCollectorArr);


  /* SNAPSHOT PROCESSING */

  // load prior/pending deletables (the state files)
  var priorDeletableSnaps = loadState(snapStateFile);

//DEBUG
  console.log('THE PERSISTED SNAPSHOT STATE (' + priorDeletableSnaps.length + '):\n' + util.inspect(priorDeletableSnaps, {showHidden: false, depth: null}));
  console.log('\n');
//DEBUG

  // make sure the snapshots in the saved state are still current;
  // first exclude from saved state any snapshots that have been marked "DND:true" since the state was written
  priorDeletableSnaps = priorDeletableSnaps.filter(function(el) {
    return snapsExcludedByDND.indexOf(el.SnapshotId) === -1;
  });
  // compact the array to remove any empty spots as deletions don't change the array length (i.e. "..item,,item..")
  priorDeletableSnaps = _.compact(priorDeletableSnaps);

  // create an independent copy (by value) as the deletions in the array will only be for detection
  var priorDeletableSnapsCheckArr = [...priorDeletableSnaps];

  // remove all snapshots currently marked for deletion (superset) from the previously marked for deletion (the state file, subset)
  priorDeletableSnapsCheckArr = deleteBy(currentlyDeletableSnaps, priorDeletableSnapsCheckArr, 'SnapshotId', 'SnapshotId', 'delby1delarr2');

  // if any items remain, they must be removed from the state (they have been either manually deleted, or a volume has been created from them)
  if (priorDeletableSnapsCheckArr.length) {

    var priorDeletableSnapsDelsArr = priorDeletableSnapsCheckArr.map(function(obj) {
     return obj.SnapshotId;
    });
    priorDeletableSnaps = priorDeletableSnaps.filter(function(el) {
      return priorDeletableSnapsDelsArr.indexOf(el.SnapshotId) === -1;
    });

    // compact the array to remove any empty spots as deletions don't change the array length (i.e. "..item,,item..")
    priorDeletableSnaps = _.compact(priorDeletableSnaps);
  }

  // remove all snapshots previously marked for deletion from the current deletables (so that just the new ones can be combined in the saved state)
  currentlyDeletableSnaps = deleteBy(priorDeletableSnaps, currentlyDeletableSnaps, 'SnapshotId', 'SnapshotId', 'delby2delarr1');

  // create pending delete object to add the new items to the persisted state
  var pendingSnapDels = [];
  for (var s of currentlyDeletableSnaps) {
    deleteObj = { 'SnapshotId': s, 'DeletionTime': deletionTime };
    pendingSnapDels.push(deleteObj);
  }  

  // combine snap state with the new deletable snapshots
  var newSnapDelState = _.union(priorDeletableSnaps, pendingSnapDels);

  // make sure there are no duplicates
  newSnapDelState = _.uniqBy(newSnapDelState, function(snap) { return snap.SnapshotId; });

  // save/persist state
  saveState(newSnapDelState, snapStateFile);


  /* VOLUME PROCESSING */

  // load prior/pending deletables (the state files)
  var priorDeletableVols = loadState(volStateFile);

//DEBUG
  console.log('THE PERSISTED VOLUME STATE (' + priorDeletableVols.length + '):\n' + util.inspect(priorDeletableVols, {showHidden: false, depth: null}));
  console.log('\n');
//DEBUG

  // make sure the volumes in the saved state are still current;
  // first exclude from saved state any volumes that have been marked "DND:true" since the state was written
  priorDeletableVols = priorDeletableVols.filter(function(el) {
    return volsExcludedByDND.indexOf(el.VolumeId) === -1;
  });
  // compact the array to remove any empty spots as deletions don't change the array length (i.e. "..item,,item..")
  priorDeletableVols = _.compact(priorDeletableVols);

  // create an independent copy (by value) as the deletions in the array will only be for detection
  var priorDeletableVolsCheckArr = [...priorDeletableVols];

  // remove all volumes currently marked for deletion (superset) from the previously marked for deletion (the state file, subset)
  priorDeletableVolsCheckArr = deleteBy(delVolCollector, priorDeletableVolsCheckArr, 'VolumeId', 'VolumeId', 'delby1delarr2');

  // if any items are remain, they must be removed from the state (they have been manually deleted)
  if (priorDeletableVolsCheckArr.length) {

    var priorDeletableVolsDelsArr = priorDeletableVolsCheckArr.map(function(obj) {
     return obj.VolumeId;
    });
    priorDeletableVols = priorDeletableVols.filter(function(el) {
      return priorDeletableVolsDelsArr.indexOf(el.VolumeId) === -1;
    });

    // compact the array to remove any empty spots as deletions don't change the array length (i.e. "..item,,item..")
    priorDeletableVols = _.compact(priorDeletableVols);
  }

  // remove all volumes previously marked for deletion from the current deletables (so that just the new ones can be combined in the saved state)
  var currentlyDeletableVols = deleteBy(priorDeletableVols, delVolCollector, 'VolumeId', 'VolumeId', 'delby2delarr1');

  // create pending delete object to add the new items to the persisted state
  var pendingVolDels = [];
  for (var s of currentlyDeletableVols) {
    deleteObj = { 'VolumeId': s, 'DeletionTime': deletionTime };
    pendingVolDels.push(deleteObj);
  }  

  // combine snap state with the new deletable volumes
  var newVolDelState = _.union(priorDeletableVols, pendingVolDels);

  // make sure there are no duplicates
  newVolDelState = _.uniqBy(newVolDelState, function(volume) { return volume.VolumeId; });

  // save/persist state
  saveState(newVolDelState, volStateFile);


  console.log('ALL DELETABLE POINT-IN-TIME SNAPSHOTS (' + deletablePitSnapshots.length + '):\n' + util.inspect(deletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');  
  console.log('THESE SOURCE SNAPSHOTS (' + activeSourceSnapshotsArr.length + ') ARE EXCLUDED FROM OTHERWISE DELETABLE POINT-IN-TIME SNAPSHOTS (if a corresponding and current PIT snapshot exists):\n' + util.inspect(activeSourceSnapshotsArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('**NOTE: all point-in-time snapshots less exclusions is NOT equal to the number of actually deletable snapshots, because for many source snapshots their source no longer exists, and hence they\'re not on the PIT list anyway! DND exclusions may also affect the final number of deletable PIT snapshots.\n');
  console.log('DELETABLE POINT-IN-TIME SNAPSHOTS AFTER EXCLUSIONS (' + actuallyDeletablePitSnapshots.length + '):\n' + util.inspect(actuallyDeletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('ORPHANS (' + orphanSnapCollectorArr.length + ') TO BE DELETED (WITH DNDs EXCLUDED):\n' + util.inspect(orphanSnapCollectorArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SOURCE SNAPSHOT DETAIL (KEEPING):\n' + util.inspect(sourceSnapshotDetail, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SOURCE VOLUME DETAIL (KEEPING):\n' + util.inspect(sourceVolumeDetail, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('NEW DELETABLE SNAPSHOTS (' + currentlyDeletableSnaps.length + '):\n' + util.inspect(currentlyDeletableSnaps, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('NEW DELETABLE VOLUMES (' + delVolCollector.length + '):\n' + util.inspect(delVolCollector, {showHidden: false, depth: null}));
  console.log('\n');

  console.log('SNAPSHOTS EXCLUDED BY DND TAG (' + snapsExcludedByDND.length + '):\n' + util.inspect(snapsExcludedByDND, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('VOLUMES EXCLUDED BY DND TAG (' + volsExcludedByDND.length + '):\n' + util.inspect(volsExcludedByDND, {showHidden: false, depth: null}));
  console.log('\n');

  console.log('THE NEW SNAPSHOT STATE (' + newSnapDelState.length + '):\n' + util.inspect(newSnapDelState, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('THE NEW VOLUME STATE (' + newVolDelState.length + '):\n' + util.inspect(newVolDelState, {showHidden: false, depth: null}));
  console.log('\n');

});
