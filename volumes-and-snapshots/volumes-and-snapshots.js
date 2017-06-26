
'use strict';

const OwnerIDs = [ 'XXXXXXXXXXXX' ];
const webhookUri = 'https://hooks.slack.com/services/AAAAAAAA/BBBBBBBB/ccccccccccccccc';
const slackChannel = '#some-slack-channel';
const slackUsername = 'AWS notices';

let RateLimiter = require('limiter').RateLimiter;
// Allow 2 requests per second. Also understands
// 'second', 'minute', 'day', or a number of milliseconds
let limiter = new RateLimiter(2, 'second');

const util = require('util');
const _ = require('lodash');
const async = require('async');
const fs = require('fs');
const moment = require('moment-timezone');
const jsonfile = require('jsonfile');
let AWS = require('aws-sdk');
AWS.config.loadFromPath('./config.json');
const snapStateFile = './snapshots-pending-delete.json';
const volStateFile = './volumes-pending-delete.json';

let ec2 = new AWS.EC2();
let deletionTime = moment().add(1, 'week').unix();
let timeNow = moment().format("DD MMM YYYY HH:mm")
let timeNowNYC = moment().tz("America/New_York").format("DD MMM YYYY HH:mm")
let deleteObj = {};

const Slack = require('slack-node');
let slack = new Slack();
slack.setWebhook(webhookUri);

let activeSourceSnapshots = new Set();
let orphanSnapCollector = new Set();
let orphanSnapCollectorArr = [];
let sourceSnapshotDetail = [];
let snapshotVolInstRef = [];
let pitSnapshotsCollectorArr = [];
let deletablePitSnapshots = [];
let snapsExcludedByDND = [];
let snapsActuallyExcludedByDND = [];
let delVolCollector = [];
let volsExcludedByDND = [];
let allVolsExcludedByDND = [];
let actuallyDeletablePitSnapshots;

let i, x;

// save persisted state into a file
function saveState(state, stateFile) {
  jsonfile.writeFile(stateFile, state, function(err) {
    if (err) console.error(err);
  });
}

// read persisted state from a file (check if it exists first)
function loadState(stateFile) {
  let deletables = [];
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
  let delidx
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

function tagger(taggerObject, tagType) {
  if (tagType != 'volumes' && tagType != 'snapshots') {
    // must be 'volumes' or 'snapshots', nothing to do here
    return 'bad argument';
  }

  // insert instance reference tags to the flagged volumes
  _.forEach(taggerObject, function(tagItem) {

    if (tagItem.TagUpdates) {

      limiter.removeTokens(1, function(err) {
        if (err) throw err
        // err will only be set if we request more than the maximum number of
        // requests we set in the constructor
        // remainingRequests tells us how many additional requests could be sent
        // right this moment

        let tagId = tagType == 'volumes' ? tagItem.VolumeId : tagItem.SnapshotId;

        // add source instance tags to the volumes that are missing them
        let taggingParams = {
          Resources: [
            tagId
          ],
          Tags: [
            {
              Key: 'RefInstanceName',
              Value: tagItem.RefInstanceName
            },
            {
              Key: 'RefInstanceId',
              Value: tagItem.RefInstanceId
            }
          ],
          DryRun: false // set to true to test tagging without actually writing tags
        };

        ec2.createTags(taggingParams, function(err, data) {
          if (err) console.log(err, err.stack); // an error occurred
        });

      }); // closes limiter

    }; // closes condition

  }); // closes iterator
}

function sendToSlack(msg) {
  slack.webhook({
    channel: slackChannel,
    username: slackUsername,
    icon_emoji: ':warning:',
    text: msg
  }, function(err, response) {
//DEBUG
//    console.log(response);
//DEBUG
  });

}

function snapLookup(snapId) {
  if (_.indexOf(actuallyDeletablePitSnapshots, snapId) !== -1) {
    return 'Old point-in-time snapshot';
  }
  else if (_.indexOf(orphanSnapCollectorArr, snapId) !== -1) {
    return 'Orphan snapshot';
  }
  else {
    return 'unknown';
  }
}

/* ============= MAIN PROGRAM START ============= */

async.parallel({
  Volumes: function(callback) {

    // acquire in-use and available (detached) volumes
    // (do not select volumes that are being created or deleted)
    let paramsDescVol = {
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

    // acquire completed snapshots
    let paramsDescSnap = {
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
  },

  Instances: function(callback) {

    // acquire all instances (these are only used for name reference; more the better so there are no filters)
    let paramsDescInst = {};
     ec2.describeInstances(paramsDescInst, function(err, data) {
      if (err) console.log(err, err.stack); // an error occurred
      else {
        callback(null, data);
      }
    });
  },

  Images: function(callback) {

    // acquire all owned images (AMIs)
    let paramsDescAMIs = {
      Owners: OwnerIDs
    };
    ec2.describeImages(paramsDescAMIs, function(err, data) {
      if (err) console.log(err, err.stack); // an error occurred
      else {
        callback(null, data);
      }
    });
  }

},

function(err, results) {

// ENABLE RAW OUTPUT FOR DEBUGGING
// console.log(util.inspect(results.Volumes.Volumes, {showHidden: false, depth: null}));
// console.log(util.inspect(results.Snapshots.Snapshots, {showHidden: false, depth: null}));
// console.log(util.inspect(results.Instances.Reservations, {showHidden: false, depth: null}));
// console.log(util.inspect(results.Images.Images, {showHidden: false, depth: null}));

  // acquire/create ec2 instance reference array
  let instanceDat = [];
  _.forEach(results.Instances.Reservations, function(reservation) {
    _.forEach(reservation.Instances, function(instance) {
      let sourceInstanceNameArr = [];
      let sourceInstanceNameVal = 'unknown';
      sourceInstanceNameArr = _.filter(instance.Tags, function(o) { return o.Key == 'Name' });
      if (sourceInstanceNameArr.length > 0 && sourceInstanceNameArr[0] != "undefined" && sourceInstanceNameArr[0].Value) {
        sourceInstanceNameVal = sourceInstanceNameArr[0].Value;
      }
      let instanceObj = { 'InstanceId': instance.InstanceId, 'InstanceName': sourceInstanceNameVal };
      instanceDat.push(instanceObj);
    });
  });

  // acquire/create AMI/snapshot reference array
  let AMIRefHash = {};
  let AMISnapExclusions = [];
  _.forEach(results.Images.Images, function(AMI) {
    if (_.has(AMI, 'BlockDeviceMappings') && 
        AMI.BlockDeviceMappings.length > 0 && 
        _.has(AMI.BlockDeviceMappings[0], 'Ebs') && 
        _.has(AMI.BlockDeviceMappings[0].Ebs, 'SnapshotId')) {

      for (i=0, x=AMI.BlockDeviceMappings.length; i<x; i++) {
        if (_.has(AMI.BlockDeviceMappings[i], 'Ebs') && 
            _.has(AMI.BlockDeviceMappings[i].Ebs, 'SnapshotId')) {

          let AMIImageId = AMI.ImageId;
          let AMISnapshotId = AMI.BlockDeviceMappings[i].Ebs.SnapshotId;
          let AMIRefObj = { AMISnapshotId : AMIImageId }

          // hash for reporting purposes
          AMIRefHash[AMISnapshotId] = AMIImageId;

          // array for exclusions
          AMISnapExclusions.push(AMISnapshotId);

        }
      }
    }
  });

  // make sure there are no duplicates
  AMISnapExclusions = _.uniq(AMISnapExclusions);

//DEBUG
//  console.log('\nAMI id/snap hash:\n' + util.inspect(AMIRefHash, {showHidden: false, depth: null}));
//  console.log('\n\nAMI exclusions:\n' + util.inspect(AMISnapExclusions, {showHidden: false, depth: null}));
//DEBUG

  let volumeInstanceRef = [];

  // iterate volumes, create corresponding ec2 instance reference
  _.forEach(results.Volumes.Volumes, function(volume) {

    let tagUpdates = false;
    let refInstanceNameArr = [];
    let refInstanceIdArr = [];
    let refInstanceNameVal = '';
    let refInstanceIdVal = '';
    
    // read 'RefInstanceName' and 'RefInstanceId' tags from the current item of the raw volume array
    if (volume.Tags.length > 0) {
      refInstanceNameArr = _.filter(volume.Tags, function(o) { return o.Key == 'RefInstanceName' });
      refInstanceIdArr = _.filter(volume.Tags, function(o) { return o.Key == 'RefInstanceId' });

      // since above the volume's tags were filtered for RefinstanceName, a non-empty value here means that the tag is present
      if (refInstanceNameArr.length > 0 && refInstanceNameArr[0] != "undefined" && refInstanceNameArr[0].Value) {
        // volume has RefInstanceName value, which can be 'unknown'
        refInstanceNameVal = refInstanceNameArr[0].Value;
      }
      else {
        // RefInstanceName tag was not found (RefInstanceId won't be there, either, unless it was manually deleted; assume none)
        tagUpdates = true;
      }
      if (refInstanceIdArr.length > 0 && refInstanceIdArr[0] != "undefined" && refInstanceIdArr[0].Value) {
        // volume has RefInstanceId value, which can be 'unknown'
        refInstanceIdVal = refInstanceIdArr[0].Value;
      }
    }

    // if empty, the tag was not found (this is the default)
    if (refInstanceNameVal == '') {
      // refInstanceName tag should contain the real name or 'unknown', and since the RefInstanceName tag was not found..
      // .. set tags to be updated..
      tagUpdates = true;
      // even if the default 'unknown' is set for their values when the corresponding instance is not known
      refInstanceNameVal = 'unknown';
      refInstanceIdVal = 'unknown';

      // if the volume is attached, get the name of its ec2 instance
      if (volume.State == 'in-use') {
        refInstanceNameVal = _.filter(instanceDat, function(o) { return o.InstanceId == volume.Attachments[0].InstanceId })[0].InstanceName;
        refInstanceIdVal = volume.Attachments[0].InstanceId;
      }
    }
         
    let volObj = {};
    volObj.VolumeId = volume.VolumeId;
    volObj.RefInstanceName = refInstanceNameVal;
    volObj.RefInstanceId = refInstanceIdVal;
    volObj.TagUpdates = tagUpdates;
          
    volumeInstanceRef.push(volObj);

  });

//DEBUG
//  console.log('\nVOLUME NAME REFERENCE:\n' + util.inspect(volumeInstanceRef, {showHidden: false, depth: null}));
//DEBUG
   
  // insert instance reference tags to the flagged volumes
  tagger(volumeInstanceRef, 'volumes');


  // ITERATE SNAPSHOTS
  _.forEach(results.Snapshots.Snapshots, function(snapshot) {

    let vol_match = false;
    let snap_match = false;

    // collect Do Not Delete (DND) tags for later exclusion
    if (_.find(snapshot.Tags, { 'Key': 'DND', 'Value': 'true' })) {
      snapsExcludedByDND.push(snapshot.SnapshotId);
    }

    let tagUpdates = false;
    let refInstanceNameArr = [];
    let refInstanceIdArr = [];
    let refInstanceNameVal = '';
    let refInstanceIdVal = '';
    let volRefObj = {};

    volRefObj.SnapshotId = snapshot.SnapshotId;
    volRefObj.VolumeId = 'unknown';

    // read 'RefInstanceName' and 'RefInstanceId' tags from the current item of the raw snapshot array
    if (snapshot.Tags.length > 0) {
      refInstanceNameArr = _.filter(snapshot.Tags, function(o) { return o.Key == 'RefInstanceName' });
      refInstanceIdArr = _.filter(snapshot.Tags, function(o) { return o.Key == 'RefInstanceId' });

      // since above the snapshot's tags were filtered for RefInstanceName, a non-empty value here means that the tag is present
      if (refInstanceNameArr.length > 0 && refInstanceNameArr[0] != "undefined" && refInstanceNameArr[0].Value) {
        // snapshot has RefInstanceName value, which can be 'unknown'
        refInstanceNameVal = refInstanceNameArr[0].Value;
      }
      else {
        // RefInstanceName tag was not found (RefInstanceId won't be there, either, unless it was manually deleted; assume none)
        tagUpdates = true;
        refInstanceNameVal = 'undef';
      }
      if (refInstanceIdArr.length > 0 && refInstanceIdArr[0] != "undefined" && refInstanceIdArr[0].Value) {
        refInstanceIdVal = refInstanceIdArr[0].Value;
      }
      else {
        tagUpdates = true;
        refInstanceIdVal = 'undef';
      }
    }
    else {
        tagUpdates = true;
        refInstanceNameVal = 'undef';
        refInstanceIdVal = 'undef';
    }

    // iterate volumes for each snapshot
    _.forEach(results.Volumes.Volumes, function(volume) {

      // see if the source volume exists; stop checking if a match is found
      // (there will be 0 or 1 matches)
      if (!vol_match && snapshot.VolumeId == volume.VolumeId) {
        vol_match = true;
        volRefObj.VolumeId = volume.VolumeId;

        // if empty, the tag was not found (this is the default)
        if (refInstanceNameVal == 'undef') {
          // refInstanceName tag should contain the real name or 'unknown', and since the RefInstanceName tag was not found..
          // .. set tags to be updated..
          tagUpdates = true;
          // even if the default 'unknown' is set for their values when the corresponding instance is not known
          refInstanceNameVal = 'unknown';
          refInstanceIdVal = 'unknown';

          // look up the snapshot's ec2 reference from the source volume's corresponding tag
          // (they do, always, exist at this point, even if just 'unknown')
          if (volume.Tags.length > 0) {
            refInstanceNameVal = _.filter(volume.Tags, function(o) { return o.Key == 'RefInstanceName' })[0].Value;
            refInstanceIdVal = _.filter(volume.Tags, function(o) { return o.Key == 'RefInstanceId' })[0].Value;
          }
        }
      }

      // find existing volumes to which this snapshot has given rise to
      if (snapshot.SnapshotId == volume.SnapshotId) {
        
        // save this snapshot id to the exclusion list for chrono snapshot wipe
        // (we don't delete snapshots that have given rise to one or more existing volumes)
        activeSourceSnapshots.add(snapshot.SnapshotId);

        // store the volume-to-snapshot reference for reporting/display purposes        
        let volRiseObj = {};
        volRiseObj.SnapshotId = snapshot.SnapshotId;
        volRiseObj.volumes = [ volume.VolumeId ];

        // extend existing volumes array if an entry exists for a snapshot already
        if (_.find(sourceSnapshotDetail, { SnapshotId: snapshot.SnapshotId })) {
          volRiseObj.volumes = _.union(volRiseObj.volumes, _.find(sourceSnapshotDetail, { 'SnapshotId': snapshot.SnapshotId  }).volumes);
          _.extend(_.find(sourceSnapshotDetail, { SnapshotId: snapshot.SnapshotId }), volRiseObj);
        }
        else {
          // .. otherwise just add a new object (this is the first snapshot found for the volume)
          sourceSnapshotDetail.push(volRiseObj);
        }
        
        // at least one snapshot was found
        snap_match = true;
      }

    }); // closes volume iteration

    volRefObj.RefInstanceName = refInstanceNameVal == 'undef' ? 'unknown' : refInstanceNameVal;
    volRefObj.RefInstanceId = refInstanceIdVal == 'undef' ? 'unknown' : refInstanceIdVal;
    volRefObj.TagUpdates = tagUpdates;

    snapshotVolInstRef.push(volRefObj);

    if (!vol_match && !snap_match) {
      // This is an orphan snapshot (no source, no destination), and must be deleted!
      orphanSnapCollector.add(snapshot.SnapshotId);
    }
    
  }); // closes snapshot iteration

  // insert instance reference tags to the flagged volumes
  tagger(snapshotVolInstRef, 'snapshots');

//DEBUG
//  console.log('\nSNAPSHOT INSTANCE REFERNCE (SNAPSHOTS WITH SOURCE VOLUMES ONLY):');
//  console.log(util.inspect(snapshotVolInstRef, {showHidden: false, depth: null}));
//  console.log('\n');
//DEBUG

  // array of snapshots that give rise to one or more existing volumes
  let activeSourceSnapshotsArr = Array.from(activeSourceSnapshots);
  activeSourceSnapshots = '';

  // array of orphan snapshots (these are deletable as-is)
  orphanSnapCollectorArr = Array.from(orphanSnapCollector);
  orphanSnapCollector = '';

  // do not consider detached volumes younger than 2 days for deletion
  let volSelectTimeLimiter = moment().subtract(2, 'days').unix();

  // ITERATE VOLUMES to create a list of detached volumes to tag for deletion,
  // and to find all point-in-time snapshots for each volume
  // (if a volume is slated for deletion, its PIT snapshots will be deleted in
  // the following cycle)
  _.forEach(results.Volumes.Volumes, function(volume) {

    let volCreateTimeStamp = moment(volume.CreateTime).unix();
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
    else {
      // record DND protection for reporting purposes also for the volumes that are currently not deletable
      if (_.find(volume.Tags, { 'Key': 'DND', 'Value': 'true' })) {
        allVolsExcludedByDND.push(volume.VolumeId);
      }
    }
    
    // include deletable vols DND protection list to the global vol DND protection list
    allVolsExcludedByDND = _.union(allVolsExcludedByDND, volsExcludedByDND);

    let pitSnapshotsCollector = new Set();
    // iterate snapshots for each volume; save found matches
    _.forEach(results.Snapshots.Snapshots, function(snapshot) {
      if (snapshot.VolumeId == volume.VolumeId) {
        
        let pitSnapshotObj = {};
        pitSnapshotObj.SnapshotId = snapshot.SnapshotId;
        pitSnapshotObj.StartTime = snapshot.StartTime;
        
        pitSnapshotsCollector.add(pitSnapshotObj);
      }
    });
    pitSnapshotsCollectorArr = Array.from(pitSnapshotsCollector);
    pitSnapshotsCollector = '';

    // sort the point-in-time snapshots for the volume, the most recent first
    pitSnapshotsCollectorArr.sort(function(a, b) {
      return new Date(b.StartTime) - new Date(a.StartTime);
    });

    // if more than one snapshot exist for a volume
    // remove all but the most recent one
    // (the snapshots left in the array will be deleted)
    if (pitSnapshotsCollectorArr.length > 1) {
      pitSnapshotsCollectorArr.shift();
    }

    // save the SnapshotId's only (drop the times), convert to an array
    for (let o in pitSnapshotsCollectorArr) {
      if (pitSnapshotsCollectorArr[o].SnapshotId != '') {
        deletablePitSnapshots.push(pitSnapshotsCollectorArr[o].SnapshotId);
      }
    }

  });

  // exclude snapshots that have given rise to existing volumes
  actuallyDeletablePitSnapshots = _.difference(deletablePitSnapshots, activeSourceSnapshotsArr);

  // exclude snapshots that are associated with AMIs (they cannot be deleted unless the AMI is deregistered)
  actuallyDeletablePitSnapshots = _.difference(deletablePitSnapshots, AMISnapExclusions);

  // create an array for reporting purposes of Snapshots slated for deletion that are protected by DND
  snapsActuallyExcludedByDND = _.union(snapsActuallyExcludedByDND, (_.intersection(actuallyDeletablePitSnapshots, snapsExcludedByDND)));
  snapsActuallyExcludedByDND = _.union(snapsActuallyExcludedByDND, (_.intersection(orphanSnapCollectorArr, snapsExcludedByDND)));
  snapsActuallyExcludedByDND = _.uniq(snapsActuallyExcludedByDND);

  // exclude snapshots marked explicitly to be saved with "DND:true" tag
  actuallyDeletablePitSnapshots = _.difference(actuallyDeletablePitSnapshots, snapsExcludedByDND);
  orphanSnapCollectorArr = _.difference(orphanSnapCollectorArr, snapsExcludedByDND);

  // make sure there are no duplicates (to prevent errors at deletion time)
  deletablePitSnapshots = _.uniq(deletablePitSnapshots);
  activeSourceSnapshotsArr = _.uniq(activeSourceSnapshotsArr);
  actuallyDeletablePitSnapshots = _.uniq(actuallyDeletablePitSnapshots);
  orphanSnapCollectorArr = _.uniq(orphanSnapCollectorArr);

  // combine remaining deletable PIT snapshots and orphans
  let currentlyDeletableSnaps = _.union(actuallyDeletablePitSnapshots, orphanSnapCollectorArr);


  /* SNAPSHOT PROCESSING */

  // load prior/pending deletables (the state files)
  let priorDeletableSnaps = loadState(snapStateFile);

//DEBUG
//  console.log('THE PERSISTED SNAPSHOT STATE (' + priorDeletableSnaps.length + '):\n' + util.inspect(priorDeletableSnaps, {showHidden: false, depth: null}));
//  console.log('\n');
//DEBUG

  // make sure the snapshots in the saved state are still current;
  // first exclude from saved state any snapshots that have been marked "DND:true" since the state was written
  priorDeletableSnaps = priorDeletableSnaps.filter(function(el) {
    return snapsExcludedByDND.indexOf(el.SnapshotId) === -1;
  });
  // compact the array to remove any empty spots as deletions don't change the array length (i.e. "..item,,item..")
  priorDeletableSnaps = _.compact(priorDeletableSnaps);

  // create an independent copy (by value) as the deletions in the array will only be for detection
  let priorDeletableSnapsCheckArr = [...priorDeletableSnaps];

  // remove all snapshots currently marked for deletion (superset) from the previously marked for deletion (the state file, subset)
  priorDeletableSnapsCheckArr = deleteBy(currentlyDeletableSnaps, priorDeletableSnapsCheckArr, 'SnapshotId', 'SnapshotId', 'delby1delarr2');

  // if any items remain, they must be removed from the state (they have been either manually deleted, or a volume has been created from them)
  if (priorDeletableSnapsCheckArr.length) {

    let priorDeletableSnapsDelsArr = priorDeletableSnapsCheckArr.map(function(obj) {
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
  let pendingSnapDels = [];
  for (let s of currentlyDeletableSnaps) {
    deleteObj = { 
      'SnapshotId': s, 
      'DeletionTime': deletionTime
    };
    pendingSnapDels.push(deleteObj);
  }  

  // combine snap state with the new deletable snapshots
  let newSnapDelState = _.union(priorDeletableSnaps, pendingSnapDels);

  // make sure there are no duplicates
  newSnapDelState = _.uniqBy(newSnapDelState, function(snap) { return snap.SnapshotId; });

  // save/persist state
  saveState(newSnapDelState, snapStateFile);


  /* VOLUME PROCESSING */

  // load prior/pending deletables (the state files)
  let priorDeletableVols = loadState(volStateFile);

//DEBUG
//  console.log('THE PERSISTED VOLUME STATE (' + priorDeletableVols.length + '):\n' + util.inspect(priorDeletableVols, {showHidden: false, depth: null}));
//  console.log('\n');
//DEBUG

  // make sure the volumes in the saved state are still current;
  // first exclude from saved state any volumes that have been marked "DND:true" since the state was written
  priorDeletableVols = priorDeletableVols.filter(function(el) {
    return volsExcludedByDND.indexOf(el.VolumeId) === -1;
  });
  // compact the array to remove any empty spots as deletions don't change the array length (i.e. "..item,,item..")
  priorDeletableVols = _.compact(priorDeletableVols);

  // create an independent copy (by value) as the deletions in the array will only be for detection
  let priorDeletableVolsCheckArr = [...priorDeletableVols];

  // remove all volumes currently marked for deletion (superset) from the previously marked for deletion (the state file, subset)
  priorDeletableVolsCheckArr = deleteBy(delVolCollector, priorDeletableVolsCheckArr, 'VolumeId', 'VolumeId', 'delby1delarr2');

  // if any items are remain, they must be removed from the state (they have been manually deleted)
  if (priorDeletableVolsCheckArr.length) {

    let priorDeletableVolsDelsArr = priorDeletableVolsCheckArr.map(function(obj) {
     return obj.VolumeId;
    });
    priorDeletableVols = priorDeletableVols.filter(function(el) {
      return priorDeletableVolsDelsArr.indexOf(el.VolumeId) === -1;
    });

    // compact the array to remove any empty spots as deletions don't change the array length (i.e. "..item,,item..")
    priorDeletableVols = _.compact(priorDeletableVols);
  }

  // remove all volumes previously marked for deletion from the current deletables (so that just the new ones can be combined in the saved state)
  let currentlyDeletableVols = deleteBy(priorDeletableVols, delVolCollector, 'VolumeId', 'VolumeId', 'delby2delarr1');

  // create pending delete object to add the new items to the persisted state
  let pendingVolDels = [];
  for (let s of currentlyDeletableVols) {
    deleteObj = { 
      'VolumeId': s,
      'DeletionTime': deletionTime
    };
    pendingVolDels.push(deleteObj);
  }  

  // combine snap state with the new deletable volumes
  let newVolDelState = _.union(priorDeletableVols, pendingVolDels);

  // make sure there are no duplicates
  newVolDelState = _.uniqBy(newVolDelState, function(volume) { return volume.VolumeId; });

  // save/persist state
  saveState(newVolDelState, volStateFile);

//DEBUG
/*
  console.log('SOURCE SNAPSHOT DETAIL (KEEPING):\n' + util.inspect(sourceSnapshotDetail, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SOURCE VOLUME DETAIL (KEEPING):\n' + util.inspect(snapshotVolInstRef, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('----------------------------------------------');
  console.log('ALL DELETABLE POINT-IN-TIME SNAPSHOTS (' + deletablePitSnapshots.length + '):\n' + util.inspect(deletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');  
  console.log('THESE SOURCE SNAPSHOTS (' + activeSourceSnapshotsArr.length + ') ARE EXCLUDED FROM OTHERWISE DELETABLE POINT-IN-TIME SNAPSHOTS (if a corresponding and current PIT snapshot exists):\n' + util.inspect(activeSourceSnapshotsArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('**NOTE: all point-in-time snapshots less exclusions is NOT equal to the number of actually deletable snapshots, because for many source snapshots their source no longer exists, and hence they\'re not on the PIT list anyway! DND exclusions may also affect the final number of deletable PIT snapshots.\n');
  console.log('DELETABLE POINT-IN-TIME SNAPSHOTS AFTER EXCLUSIONS (' + actuallyDeletablePitSnapshots.length + '):\n' + util.inspect(actuallyDeletablePitSnapshots, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('ORPHANS (' + orphanSnapCollectorArr.length + ') TO BE DELETED (WITH DNDs EXCLUDED):\n' + util.inspect(orphanSnapCollectorArr, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('NEW DELETABLE SNAPSHOTS (' + currentlyDeletableSnaps.length + '):\n' + util.inspect(currentlyDeletableSnaps, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('NEW DELETABLE VOLUMES (' + delVolCollector.length + '):\n' + util.inspect(delVolCollector, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('ALL SNAPSHOTS EXCLUDED BY DND TAG, DELETABLE OR NOT (' + snapsExcludedByDND.length + '):\n' + util.inspect(snapsExcludedByDND, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('SNAPSHOTS ACTUALLY EXCLUDED BY DND TAG (' + snapsActuallyExcludedByDND.length + '):\n' + util.inspect(snapsActuallyExcludedByDND, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('ALL VOLUMES EXCLUDED BY DND TAG, DELETABLE OR NOT (' + allVolsExcludedByDND.length + '):\n' + util.inspect(allVolsExcludedByDND, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('VOLUMES ACTUALLY EXCLUDED BY DND TAG, i.e. of available (detached) volumes only (' + volsExcludedByDND.length + '):\n' + util.inspect(volsExcludedByDND, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('THE NEW SNAPSHOT STATE (' + newSnapDelState.length + '):\n' + util.inspect(newSnapDelState, {showHidden: false, depth: null}));
  console.log('\n');
  console.log('THE NEW VOLUME STATE (' + newVolDelState.length + '):\n' + util.inspect(newVolDelState, {showHidden: false, depth: null}));
  console.log('\n');
*/
//DEBUG

  // REPORT: Volumes and Snapshots slated for deletion
  let sMsg = '[BEGIN VOLUME/SNAPSHOT REPORT@ ' + timeNowNYC + ' (ET)]========================================================';

  if (newVolDelState.length > 0) {
    sMsg += "\n\n*VOLUMES PENDING DELETE " + timeNow + " (UTC):*\n\n";

    for (i=0, x=newVolDelState.length; i<x; i++) {
      let t = moment.unix(newVolDelState[i].DeletionTime).format("DD MMM YYYY HH:mm");
      let vid = newVolDelState[i].VolumeId;
      let volDetail = _.find(results.Volumes.Volumes, { VolumeId: vid });
      let thisEC2instName = _.find(volDetail.Tags, { Key: 'RefInstanceName' }).Value;
      let thisEC2instId = _.find(volDetail.Tags, { Key: 'RefInstanceId' }).Value;
      sMsg += 'Detached volume ' + vid + ' will be deleted after ' + t + ' (UTC)\n';
      sMsg += '      Created: ' + moment(volDetail.CreateTime).format("DD MMM YYYY HH:mm") + ' (UTC)\n';
      sMsg += '      EC2 reference: ' + thisEC2instId + ' / ' + thisEC2instName + '\n\n';
    }
  }
  else {
    sMsg += "\n\nNo volumes are pending delete at this time.\n\n";
  }

  if (volsExcludedByDND.length > 0) {
    sMsg += "\n\n*==> The following volume(s) that would otherwise have been marked for deletion, are protected by a DoNotDelete tag ('DND=true'):*\n\n";
    for (i=0, x=volsExcludedByDND.length; i<x; i++) {
      let vid = volsExcludedByDND[i];
      let volDetail = _.find(results.Volumes.Volumes, { VolumeId: vid });
      let thisEC2instName = _.find(volDetail.Tags, { Key: 'RefInstanceName' }).Value;
      let thisEC2instId = _.find(volDetail.Tags, { Key: 'RefInstanceId' }).Value;
      sMsg += 'Volume ' + vid + ' is protected by DND and will not be deleted\n';
      sMsg += '      Created: ' + moment(volDetail.CreateTime).format("DD MMM YYYY HH:mm") + ' (UTC)\n';
      sMsg += '      EC2 reference: ' + thisEC2instId + ' / ' + thisEC2instName + '\n\n';
    }
  }

  // REPORT: Snapshots slated for deletion
  if (newSnapDelState.length > 0) {
    sMsg += "\n\n\n*SNAPSHOTS PENDING DELETE " + timeNow + " (UTC):*\n\n";

    for (i=0, x=newSnapDelState.length; i<x; i++) {
      let t = moment.unix(newSnapDelState[i].DeletionTime).format("DD MMM YYYY HH:mm");
      let snid = newSnapDelState[i].SnapshotId;
      let snapDetail = _.find(results.Snapshots.Snapshots, { SnapshotId: snid });
      let thisEC2instName = _.find(snapDetail.Tags, { Key: 'RefInstanceName' }).Value;
      let thisEC2instId = _.find(snapDetail.Tags, { Key: 'RefInstanceId' }).Value;
      sMsg += snapLookup(snid) + ' ' + snid + ' will be deleted after ' + t + ' (UTC)\n';
      sMsg += '      Description: ' + snapDetail.Description + ' \n';
      sMsg += '      Created: ' + moment(snapDetail.StartTime).format("DD MMM YYYY HH:mm") + ' (UTC)\n';
      sMsg += '      EC2 reference: ' + thisEC2instId + ' / ' + thisEC2instName + '\n\n';
    }
  }
  else {
    sMsg += "\n\n\nNo snapshots are pending delete at this time.\n\n";
  }

  if (snapsActuallyExcludedByDND.length > 0) {
    sMsg += "\n\n*==> The following snapshot(s) that would otherwise have been marked for deletion, are protected by a DoNotDelete tag ('DND=true'):*\n\n";
    for (i=0, x=snapsActuallyExcludedByDND.length; i<x; i++) {
      let snid = snapsActuallyExcludedByDND[i];
      let snapDetail = _.find(results.Snapshots.Snapshots, { SnapshotId: snid });
      let thisEC2instName = _.find(snapDetail.Tags, { Key: 'RefInstanceName' }).Value;
      let thisEC2instId = _.find(snapDetail.Tags, { Key: 'RefInstanceId' }).Value;
      sMsg += 'Snapshot ' + snid + ' is protected by DND and will not be deleted.\n';
      sMsg += '      Description: ' + snapDetail.Description + ' \n';
      sMsg += '      Created: ' + moment(snapDetail.StartTime).format("DD MMM YYYY HH:mm") + ' (UTC)\n';
      sMsg += '      EC2 reference: ' + thisEC2instId + ' / ' + thisEC2instName + '\n\n';
    }
  }

  sMsg += '\n\n';
  sMsg += '==========================================================[END VOLUME/SNAPSHOT REPORT@ ' + timeNowNYC + ' (ET)]';

  sendToSlack(sMsg);

});
