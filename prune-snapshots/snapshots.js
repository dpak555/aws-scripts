
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
let orphanCollectorArr;
let PitSnapshotsCollectorArr;
let DeletablePitSnapshots = [];

/*
array.sort(function(a,b){
  // Turn your strings into dates, and then subtract them
  // to get a value that is either negative, positive, or zero.
  return new Date(b.date) - new Date(a.date);
});
*/

async.parallel({
    Volumes: function(callback) {

      // acquire in-use volumes
      var paramsDescVol = {
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
            Name: "status", 
            Values: [
              "completed"
            ]
          }
        ],
        OwnerIds: [
          "248783370565"
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

  // console.log(util.inspect(results.Snapshots.Snapshots, {showHidden: false, depth: null}));

  // iterate snapshots
  _.forEach(results.Snapshots.Snapshots, function(snapshot) {

    console.log('snapshot: ' + snapshot.SnapshotId);

    let vol_match = false;
    let matchedVolumeId;
    let snap_match = false;
    let snapVols = new Set();

    // iterate volumes for each snapshot
    _.forEach(results.Volumes.Volumes, function(volume) {

      // see if the source volume exists; stop chaecking if a match is found
      // (there will be 0 or 1 matches)
      if (!vol_match && snapshot.VolumeId == volume.VolumeId) {
        matchedVolumeId = snapshot.VolumeId;
        vol_match = true;
      }

      // find existing volumes to which this snapshot has given rise to
      if (snapshot.SnapshotId == volume.SnapshotId) {
        
        // add to the array of volumes created from this snapshot
        // (this is for output/reporting only)
        snapVols.add(volume.VolumeId);
        
        // save this snapshot id to the exclusion list for chrono snapshot wipe
        // (we don't delete snapshots that have given rise to one or more existing volumes)
        activeSourceSnapshots.add(snapshot.SnapshotId);
        
        // at least one snapshot was found
        snap_match = true;
      }

    });
    
    if (vol_match) {
      console.log('SOURCE VOLUME EXISTS: ' + matchedVolumeId);
    }
    else {
      console.log('source volume (' + snapshot.VolumeId + ') not present');
    }

    if (snap_match) {
      var matchedVolumeIds = Array.from(snapVols);
      snapVols = '';
      console.log('THIS SNAPSHOT HAS GIVEN RISE TO THE FOLLOWING EXISTING VOLUME(S):');
      console.log(util.inspect(matchedVolumeIds, {showHidden: false, depth: null}));
    }
    else {
      console.log('No existing volumes created from this snapshot.');
    }

    if (!vol_match && !snap_match) {
      console.log('THIS IS AN ORPHAN SNAPSHOT! ORPAHNS MUST BE KILLED!!');
      orphanCollector.add(snapshot.SnapshotId);
    }
    
    console.log('');
    
  });

  // array of snapshots that give rise to one or more existing volumes
  let activeSourceSnapshotsArr = Array.from(activeSourceSnapshots);
  activeSourceSnapshots = '';

  // array of orphan snapshots
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

    // sort the PIT snapshots for the volume, most recent first
    PitSnapshotsCollectorArr.sort(function(a,b) {
      return new Date(b.StartTime) - new Date(a.StartTime);
    });

    // if there are more than one snapshot for the volume
    // remove all but the first one (the items in array will be deleted)
    if (PitSnapshotsCollectorArr.length > 1) {
      PitSnapshotsCollectorArr.shift();
    }

    // save the SnapshotId's only (drop the times), convert to an array
    for (var o in PitSnapshotsCollectorArr) {
      if (PitSnapshotsCollectorArr[o].SnapshotId != '') {
        DeletablePitSnapshots.push(PitSnapshotsCollectorArr[o].SnapshotId);
      }
    }

//    if (PitSnapshotsCollectorArr.length > 0) {   
//      console.log('Deletable snapshots (except for the latest) for volume ' + volume.VolumeId);
//      console.log(util.inspect(PitSnapshotsCollectorArr, {showHidden: false, depth: null}));
//    }
      
  });

  // exclude active source snapshots from the deletion list
  _.difference(DeletablePitSnapshots, activeSourceSnapshotsArr)

  console.log('DELETABLE PIT SNAPSHOTS (' + DeletablePitSnapshots.length + '): ' + util.inspect(DeletablePitSnapshots, {showHidden: false, depth: null}));
  console.log(' ');
  console.log('ORPHANZ TO KILL:\n' + util.inspect(orphanCollectorArr, {showHidden: false, depth: null}));

});
