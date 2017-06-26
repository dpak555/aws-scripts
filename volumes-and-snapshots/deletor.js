
'use strict';

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
var volStatesAvailable = false;
var snapStatesAvailable = false;
var statesAvailable = false;

let ec2 = new AWS.EC2();
let timeNow = moment().format("DD MMM YYYY HH:mm")
let timeNowNYC = moment().tz("America/New_York").format("DD MMM YYYY HH:mm")

const Slack = require('slack-node');
let slack = new Slack();
slack.setWebhook(webhookUri);

let i, x, sMsg;

// read state from a file (check if it exists first)
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

// save state into a file
function saveState(state, stateFile) {
  jsonfile.writeFile(stateFile, state, function(err) {
    if (err) console.error(err);
  });
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

/* ============= MAIN PROGRAM START ============= */

let volumeState = loadState(volStateFile);
volStatesAvailable = volumeState.length > 0 ? true : false;

let snapshotState = loadState(snapStateFile);
snapStatesAvailable = snapshotState.length > 0 ? true : false;

statesAvailable = volStatesAvailable || snapStatesAvailable ? true : false;

//DEBUG
/*
if (snapStatesAvailable) {
  console.log('\n\nSNAPSHOT STATES:\n' + util.inspect(snapshotState, {showHidden: false, depth: null}));
}
else {
  console.log('\n\nno snapshot states\n');
}

if (volStatesAvailable) {
  console.log('\n\nVOLUME STATES:\n' + util.inspect(volumeState, {showHidden: false, depth: null}));
}
else {
  console.log('\n\nno volume states\n');
}
*/
//DEBUG

let deletedVolumes = [];
let failedVolDels = [];
let deletedSnapshots = [];
let failedSnapDels = [];

let volStateAfter = [];
let snapStateAfter = [];

// REPORT: Begin Volumes and Snapshots deletion report message
sMsg = '\n\n[BEGIN VOLUME/SNAPSHOT DELETION REPORT@ ' + timeNowNYC + ' (ET)]================================================\n';

if (statesAvailable) {

  let deletableVolumes = [];
  let deletableSnapshots = [];

  let currentTime = moment().unix();

  let q = async.queue(function(item, callback) {

    limiter.removeTokens(1, function(err) {
      if (err) throw err
      // err will only be set if we request more than the maximum number of
      // requests we set in the constructor
      // remainingRequests tells us how many additional requests could be sent
      // right this moment

      if (_.has(item, 'VolumeId')) {

        let params = {
          VolumeId: item.VolumeId,
          DryRun: false
        };

        ec2.deleteVolume(params, function(err, data) {
          if (err) {
            failedVolDels.push(item);
            //DEBUG
            // console.log('\nVolume delete failed: ' + item.VolumeId);
            // console.log(err, err.stack); // an error occurred
            //DEBUG
            callback();
          }
          else {
            deletedVolumes.push(item);
            //DEBUG
            // console.log('\nVolume delete succeeded: ' + item.VolumeId);
            // console.log(data);           // successful response
            //DEBUG
            callback();
          }
        });
      }
      else if (_.has(item, 'SnapshotId')) {

        var params = {
          SnapshotId: item.SnapshotId,
          DryRun: false
        };

        ec2.deleteSnapshot(params, function(err, data) {
          if (err) {
            failedSnapDels.push(item);
            //DEBUG
            // console.log('\nSnapshot delete failed: ' + item.SnapshotId);
            // console.log(err, err.stack); // an error occurred
            //DEBUG
            callback();
          }
          else {
            deletedSnapshots.push(item);
            //DEBUG
            // console.log('\nsucceeded: ' + item.SnapshotId);
            // console.log(data);           // successful response
            //DEBUG
            callback();
          }
        });

      }
      else {

        // this should never happen, but..
        callback();
      }

    }); // closes limiter

  }, 1); // closes async.queue

  // iterate and delete volumes
  if (volumeState.length > 0) {
    _.forEach(volumeState, function(volume) {

      if (volume.DeletionTime < currentTime) {
        deletableVolumes.push(volume);
      }
      else {
        volStateAfter.push(volume);
      }

    });

    //DEBUG
    // console.log('\n\nSELECTED VOLUMES:\n' + util.inspect(deletableVolumes, {showHidden: false, depth: null}));
    // console.log('\n\nSKIPPED VOLUMES:\n' + util.inspect(volStateAfter, {showHidden: false, depth: null}));
    //DEBUG

    _.forEach(deletableVolumes, function(volume) {
      // queue volume for deletion
      q.push(volume, function(err) {
        //DEBUG
        // console.log('Volume ' + volume.VolumeId + ' processed');
        //DEBUG
      });
    });

  }
  else {
    volStatesAvailable = false;
  }

  // iterate and delete snapshots
  if (snapshotState.length > 0) {
    _.forEach(snapshotState, function(snapshot) {

      if (snapshot.DeletionTime < currentTime) {
        deletableSnapshots.push(snapshot);
      }
      else {
        snapStateAfter.push(snapshot);
      }

    });

    //DEBUG
    // console.log('\n\nSELECTED SNAPSHOTS:\n' + util.inspect(deletableSnapshots, {showHidden: false, depth: null}));
    // console.log('\n\SKIPPED SNAPSHOTS:\n' + util.inspect(snapStateAfter, {showHidden: false, depth: null}));
    //DEBUG

    _.forEach(deletableSnapshots, function(snapshot) {
      // queue snapshot for deletion
      q.push(snapshot, function(err) {
        //DEBUG
        // console.log('snapshot ' + snapshot.SnapshotId + ' processed');
        //DEBUG
      });
    });

  }
  else {
    snapStatesAvailable = false;
  }

  if (deletableVolumes.length == 0 && deletableSnapshots.length == 0) {
    sMsg += '\n*None of the existing volume or snapshot states were ready for deletion. No action was taken.*\n';
    sMsg += '\n=================================================[END VOLUME/SNAPSHOT DELETION REPORT@ ' + timeNowNYC + ' (ET)]';
    sendToSlack(sMsg);
  }

  q.drain = function() {

    //DEBUG
    /*
    console.log('\n\nDeleted volumes:\n' + util.inspect(deletedVolumes, {showHidden: false, depth: null}));
    console.log('\n\nVolume delete failed:\n' + util.inspect(failedVolDels, {showHidden: false, depth: null}));
    console.log('\n\nDeleted snapshots:\n' + util.inspect(deletedSnapshots, {showHidden: false, depth: null}));
    console.log('\n\nSnapshot delete failed:\n' + util.inspect(failedSnapDels, {showHidden: false, depth: null}));
    */
    //DEBUG

    // combine snap state with the new deletable volumes
    let newVolState = _.union(failedVolDels, volStateAfter);
    let newSnapState = _.union(failedSnapDels, snapStateAfter);

    // save/persist the updated states
    saveState(newVolState, volStateFile);
    saveState(newSnapState, snapStateFile);

    if (deletedVolumes.length > 0) {
      sMsg += '\n*THE FOLLOWING DETACHED VOLUMES WERE DELETED:*\n';
  
      for (i=0, x=deletedVolumes.length; i<x; i++) {
        sMsg += deletedVolumes[i].VolumeId + '\n';
      }
    }
    else {
      sMsg += '\n*No volumes were deleted.*\n';
    }
    
    if (failedVolDels.length > 0) {
      sMsg += '\n*THE FOLLOWING DETACHED VOLUMES FAILED TO DELETE, AND WERE RETURNED TO THE PENDING DELETE STATE:*\n';

      for (i=0, x=failedVolDels.length; i<x; i++) {
        sMsg += failedVolDels[i].VolumeId + '\n';
      }
    }

    if (deletedSnapshots.length > 0) {
      sMsg += '\n*THE FOLLOWING SNAPSHOTS WERE DELETED:*\n';

      for (i=0, x=deletedSnapshots.length; i<x; i++) {
        sMsg += deletedSnapshots[i].SnapshotId + '\n';
      }
    }
    else {
      sMsg += '\n*No snapshots were deleted.*\n';
    }

    if (failedSnapDels.length > 0) {
      sMsg += '\n*THE FOLLOWING SNAPSHOTS FAILED TO DELETE, AND WERE RETURNED TO THE PENDING DELETE STATE:*\n';

      for (i=0, x=failedSnapDels.length; i<x; i++) {
        sMsg += failedSnapDels[i].SnapshotId + '\n';
      }
    }

    sMsg += '\n=================================================[END VOLUME/SNAPSHOT DELETION REPORT@ ' + timeNowNYC + ' (ET)]';
    sendToSlack(sMsg);

  }
}
else {
//DEBUG
// console.log('\n\nNo states available (empty, corrupt, or no state files).\n');
//DEBUG

  sMsg += '\n*No deletable volume or snapshot states were found. No action was taken.*\n';
  sMsg += '\n=================================================[END VOLUME/SNAPSHOT DELETION REPORT@ ' + timeNowNYC + ' (ET)]';
  sendToSlack(sMsg);
}
