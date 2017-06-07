
'use strict';

var RateLimiter = require('limiter').RateLimiter;
// Allow 2 requests per second. Also understands
// 'second', 'minute', 'day', or a number of milliseconds
var limiter = new RateLimiter(2, 'second');

const util = require('util');
const _ = require('lodash');
const async = require('async');
let AWS = require('aws-sdk');
AWS.config.loadFromPath('./config.json');

let ec2 = new AWS.EC2();

let activeSourceSnapshots = new Set();
let orphanCollector = new Set();
let orphanCollectorArr = [];
let sourceSnapshotDetail = [];
let sourceVolumeDetail = [];
let PitSnapshotsCollectorArr = [];
let DeletablePitSnapshots = [];

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

  // iterate snapshots
  _.forEach(results.Snapshots.Snapshots, function(snapshot) {

    let vol_match = false;
    let snap_match = false;

    // iterate volumes for each snapshot
    _.forEach(results.Volumes.Volumes, function(volume) {

      // see if the source volume exists; stop chaecking if a match is found
      // (there will be 0 or 1 matches)
      if (!vol_match && snapshot.VolumeId == volume.VolumeId) {
        vol_match = true;

        let volObject = {};
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
        let localObject = {};
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
  let activeSourceSnapshotsArr = Array.from(activeSourceSnapshots);
  activeSourceSnapshots = '';

  // array of orphan snapshots (these are deletable as-is)
  orphanCollectorArr = Array.from(orphanCollector);
  orphanCollector = '';

  // iterate volumes to find all point-in-time snapshots for each volume
  _.forEach(results.Volumes.Volumes, function(volume) {
  
    let PitSnapshotsCollector = new Set();
    // iterate snapshots for each volume; save found matches
    _.forEach(results.Snapshots.Snapshots, function(snapshot) {
      if (snapshot.VolumeId == volume.VolumeId) {
        
        let localObject = new Object();
        localObject.SnapshotId = snapshot.SnapshotId;
        localObject.StartTime = snapshot.StartTime;
        
        PitSnapshotsCollector.add(localObject);
      }
    });
    PitSnapshotsCollectorArr = Array.from(PitSnapshotsCollector);
    PitSnapshotsCollector = '';

    // sort the point-in-time snapshots for the volume, the most recent first
    PitSnapshotsCollectorArr.sort(function(a,b) {
      return new Date(b.StartTime) - new Date(a.StartTime);
    });

    // if more than one snapshot exist for a volume
    // remove all but the most recent one
    // (the snapshots left in the array will be deleted)
    if (PitSnapshotsCollectorArr.length > 1) {
      PitSnapshotsCollectorArr.shift();
    }

    // save the SnapshotId's only (drop the times), convert to an array
    for (var o in PitSnapshotsCollectorArr) {
      if (PitSnapshotsCollectorArr[o].SnapshotId != '') {
        DeletablePitSnapshots.push(PitSnapshotsCollectorArr[o].SnapshotId);
      }
    }

  });

  // exclude snapshots that have given rise to existing volumes
  let ActuallyDeletablePitSnapshots = _.difference(DeletablePitSnapshots, activeSourceSnapshotsArr)

  // make sure there are no duplicates (to prevent errors at deletion time)
  DeletablePitSnapshots = _.uniq(DeletablePitSnapshots);
  activeSourceSnapshotsArr = _.uniq(activeSourceSnapshotsArr);
  ActuallyDeletablePitSnapshots = _.uniq(ActuallyDeletablePitSnapshots);
  orphanCollectorArr = _.uniq(orphanCollectorArr);

  console.log('ALL POINT-IN-TIME SNAPSHOTS (' + DeletablePitSnapshots.length + '):\n' + util.inspect(DeletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');  
  console.log('THESE SOURCE SNAPSHOTS (' + activeSourceSnapshotsArr.length + ') ARE EXCLUDED FROM OTHERWISE DELETABLE POINT-IN-TIME SNAPSHOTS:\n' + util.inspect(activeSourceSnapshotsArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('**NOTE: all point-in-time snapshots less exclusions is NOT equal to the number of actually deletable snapshots, because for many source snapshots their source no longer exists, and hence they\'re not on the PIT list anyway!\n');
  console.log('DELETABLE POINT-IN-TIME SNAPSHOTS AFTER EXCLUSION (' + ActuallyDeletablePitSnapshots.length + '):\n' + util.inspect(ActuallyDeletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('ORPHANS (CAN BE DELETED):\n' + util.inspect(orphanCollectorArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SOURCE SNAPSHOT DETAIL:\n' + util.inspect(sourceSnapshotDetail, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SOURCE VOLUME DETAIL:\n' + util.inspect(sourceVolumeDetail, {showHidden: false, depth: null}));
  console.log('\n');
  
});
