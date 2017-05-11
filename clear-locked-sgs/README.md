###AWS Utility script for unlocking (and deleting) cross-linked security groups

This script makes it reasonably easy to purge security groups which are crosslinked by `UserIdGroupPairs`, and hence cannot be deleted from AWS console, or simply with the CLI (if there are many such groups).

An equivalent CLI command to remove the cross-linking would be something like this:

`aws ec2 revoke-security-group-ingress --group-id sg-1234567e --ip-permissions '[{ "IpProtocol" : "icmp", "FromPort" : -1, "ToPort" : -1, "UserIdGroupPairs" : [ {"UserId": "123123123123","GroupId": "sg-7654321a"}, { "UserId": "123123123123", "GroupId": "sg-1234567e"} ] }]'`

However, with, say, hundreds of such cross-linked groups this becomes tedious.

With this script you can follow these steps:

1. Pull the list of security groups with:
`aws ec2 describe-security-groups --output json > ~/securitygroups.json`

2. [optional] Filter the list with [jmespath](http://jmespath.org/) and its "exploration" interafce [jpterm](https://github.com/jmespath/jmespath.terminal):

 `jpterm -o securitygroups.json securitygroups.json`

 Once you have the desired filter in place, exit with trl-c to write the filtered output to the output file defined with `-o`. You can also manually edit the JSON file to exclude security groups. This ensures that the script will act only on a desired subset of the security groups, no matter what.
 
 Configure this output file to be used by `sg-unlock.js`, then execute it with `node sg-unlock.js`.
 
 Note that JMESpath is also built in to AWS CLI so that you can execute the filter as a part of the query. See [AWS CLI documentation](http://docs.aws.amazon.com/cli/latest/userguide/controlling-output.html#controlling-output-filter) for details.
 
3. You can at this point pull a new list (as in step 1), or just use the same JSON to execute the deletion process using the `sg-delete.js` script.

** NOTE: This was written with node v6.10.3, and is offered without any guarantees or warranties, so please know what you're doing if you use this script as a starting point or as an example. Script contains some modified bits and pieces of public domain code examples from StackOverflow. 

The script is offered under MIT license.
