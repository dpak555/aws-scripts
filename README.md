
# AWS Utility Scripts

This repository contains non-proprietary (MIT license) utility scripts for use with AWS.

* **aws-iam-rotate-keys.sh** - rotate AWS access keys stored in the user's `~/.aws/config` file. If you have set the policy for a user to have maximum of two concurrent keys, this script will first make sure there is just one existing key by allowing user to delete an existing key that is not in use. It then proceeds to create the new keys, test that they work, replace the keys in the user's `~/.aws/config` file, and finally remove the old key that was replaced. The script was created and tested on macOS, but should work as-is or with minor modifications also on Linux.

* **clear-locked-sgs/** - two Node.js scripts to unlock cross-linked security groups and delete them.

* **volumes-and-snapshots/** - `volumes-and-snapshots.js` and `deletor.js` scripts for pruning abandoned (detached, available) volumes.