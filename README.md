
# AWS Utility Scripts

This repository contains non-proprietary (MIT license) utility scripts for use with AWS.

* **aws-iam-rotate-keys.sh** - rotates AWS access keys stored in the user's `~/.aws/credentials` file. If you have set the policy for a user to have maximum of two concurrent keys, this script will first make sure there is just one existing key by allowing user to delete an existing key that is not in use. It then proceeds to create the new keys, test that they work, replace the keys in the user's `~/.aws/credentials` file, and finally remove the old key that was replaced. This is an interactive script, and as such it does not take arguments. The script was written for macOS, but portability for Linux has been added. Multiple profiles are supported, as is MFA when used in conjunction with `awscli-mfa.sh` script. The script also displays the key ages, and the actual IAM user name associated with each credential profile.<br><br>For more details, read my blog post about this script [here](https://random.ac/cess/2017/10/28/aws-cli-key-rotation-script-v2/).

* **awscli-mfa.sh** - Makes it easy to use MFA sessions with AWS CLI. Multiple profiles are supported. This is an interactive script (since it prompts for the current MFA one time pass code), and as such it does not take arguments. The script was written for macOS, but portability for Linux has been added.<br><br>For more details, read my blog post about this script [here](https://random.ac/cess/2017/10/29/easy-mfa-and-profile-switching-in-aws-cli/).

* **get-key-ages.py** - List the ages of all AWS IAM API keys in the account (this assumes properly configured `~/.aws/config`, and obviously sufficient access level to this information. Currently the output is tab delimited, and to the standard output, from where it can be cut-and-pasted to, say, Excel. In other words a quick-and-dirty utility script for a key age report. 

* **clear-locked-sgs/** - two Node.js scripts to unlock cross-linked security groups and delete them.

* **volumes-and-snapshots/** - `volumes-and-snapshots.js` and `deletor.js` scripts for pruning abandoned (detached, available) volumes.

