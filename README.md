
# AWS Utility Scripts

This repository contains non-proprietary (MIT license) utility scripts for use with AWS.

* **aws-iam-rotate-keys.sh** - rotate AWS access keys stored in the user's `~/.aws/credentials` file. If you have set the policy for a user to have maximum of two concurrent keys, this script will first make sure there is just one existing key by allowing user to delete an existing key that is not in use. It then proceeds to create the new keys, test that they work, replace the keys in the user's `~/.aws/credentials` file, and finally remove the old key that was replaced. The script was created and tested on macOS, but should work as-is or with minor modifications also on Linux.

* **awscli-mfa.sh** - Makes it easy to use MFA sessions with AWS CLI. Multiple profiles are supported. This is an interactive script (since it prompts for the current MFA one time pass code), and so it takes no arguments.

* **get-key-ages.py** - List the ages of all AWS IAM API keys in the account (this assumes properly configured `~/.aws/config`, and obviously sufficient access level to this information. Currently the output is tab delimited, and to the standard output, from where it can be cut-and-pasted to, say, Excel. In other words a quick-and-dirty utility script for a key age report. 

* **clear-locked-sgs/** - two Node.js scripts to unlock cross-linked security groups and delete them.

* **volumes-and-snapshots/** - `volumes-and-snapshots.js` and `deletor.js` scripts for pruning abandoned (detached, available) volumes.

