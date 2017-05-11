
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

// read and parse securitygroups.json
let sgs = require('./securitygroups');

function isEmpty(val) {
  var len = val.length,
      i;

  if (len > 0) {
    for (i = 0; i < len; ++i) {
      if (!emptyObject(val[i])) {
        return false;
      }
    }
  }
  return true;
}

function emptyObject(o) {
  for (var key in o) {
    if (o.hasOwnProperty(key)) {
      return false;
    }
  }
  return true;
}

_.forOwn(sgs.SecurityGroups, function(value, key) {

  // only act on groups with "Some description" in Description
  // (but you can also filter by tags, etc.)
  if (_.has(value, 'Description') &&
      value.Description == 'Some description' ) {

    console.log('Now processing security group ' + value.GroupId + ' (' + value.GroupName + ')');

    if (_.has(value, 'IpPermissions') &&
        !(isEmpty(value.IpPermissions))) {
        
      _.forOwn(value.IpPermissions, function(groupValue, groupKey) {
        if (_.has(groupValue, 'UserIdGroupPairs') &&
            !(isEmpty(groupValue.UserIdGroupPairs))) {

          limiter.removeTokens(1, function (err) {
            if (err) throw err
            // err will only be set if we request more than the maximum number of
            // requests we set in the constructor
            // remainingRequests tells us how many additional requests could be sent
            // right this moment

            console.log('  .. queuing clearaing UserIdGroupPairs in ' + value.GroupId);
          
            let thisIpPermissions = [];
            delete groupValue.IpRanges;
            delete groupValue.Ipv6Ranges;
            delete groupValue.PrefixListIds;
            thisIpPermissions[0] = groupValue;

            // change "DryRun" to "true" to actually clear the UserIdGroupPairs
            let params = {
              DryRun: true,
              GroupId: value.GroupId,
              IpPermissions: thisIpPermissions
            };

            console.log(util.inspect(params, {depth: null}));

            ec2.revokeSecurityGroupIngress(params, function(err, data) {
              if (err) {
                console.log(err, err.stack); // an error occurred
              }
              else {
                console.log('  .. UserIdGroupPairs cleared in ' + value.GroupId);
              }
            });

          }); // closes the rate limiter

        }
          
      });
        
    } 

  }

});
