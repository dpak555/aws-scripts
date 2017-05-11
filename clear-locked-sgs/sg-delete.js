
'use strict';

var RateLimiter = require('limiter').RateLimiter;
// Allow 2 requests per second. Also understands
// 'second', 'minute', 'day', or a number of milliseconds
var limiter = new RateLimiter(2, 'second');

const util = require('util');
const _ = require('lodash');
let AWS = require('aws-sdk');
AWS.config.loadFromPath('./config.json');

let ec2 = new AWS.EC2();

// read and parse securitygroups-deletable.json
let sgs = require('./securitygroups-deletable');

_.forOwn(sgs.SecurityGroups, function(value, key) {

  // only act on groups with "Some description" in Description
  // (but you can also filter by tags, etc.)
  if (_.has(value, 'Description') &&
      value.Description == 'Some description' ) {

    console.log('Now queuing security group ' + value.GroupId + ' (' + value.GroupName + ') for deletion');

    limiter.removeTokens(1, function (err) {
      if (err) throw err
      // err will only be set if we request more than the maximum number of
      // requests we set in the constructor
      // remainingRequests tells us how many additional requests could be sent
      // right this moment

      // change "DryRun" to "true" to actually delete the filtered security groups
      let params = {
        DryRun: false,
        GroupId: value.GroupId
      };

      ec2.deleteSecurityGroup(params, function(err, data) {
        if (err) {
          console.log('  Error deleting security group ' + value.GroupId + ' (' + value.GroupName + ')');
          console.log(err, err.stack); // an error occurred
        }
        else {
          console.log('  Deleted security group ' + value.GroupId + ' (' + value.GroupName + ')');
        }
      });

    }); // closes the rate limiter

  }
          
});
