### Automatic EBS volume and Snapshot pruning script

This script makes it easy to keep unused volumes and excess snapshots to a minimum.

The deletion logic:

* Detached ("available") volumes that have been in "available" state for more than two days are marked for deletion.

* Snapshots whose source volume no longer exists, and of which no volumes have been created ("orphan snapshots") are marked for deletion.

* All but the latest snapshot of each existing volume are marked for deletion (unless an older snapshot is used to create one or more volumes, in which case such snapshots are preserved).

* Volumes and snapshots which have Do Not Delete ("DND = true") tag set are never considered for deletion even if they are a detached volumes or orphan snapshots. If you want to stop a volume or snapshot from being deleted after they show up on the deletion report, just set a tag `DND` with the value `true`, and the script will ignore it. 

Volumes and snapshots which have been marked for deletion are given one week before the deletion occurs. A report of the volumes pending deletion is pushed daily to the defined Slack channel, along with a daily report of volumes that have been deleted (after they have been in the deletion queue for one week).

The script also automatically creates `RefInstanceName` and `RefInstanceId` tags on all volumes and snapshots (both that are considered for deletion and those that are currently in use). The values of those tags are derived from the name and the instance ID, respectively, of the ec2 instance the volume is attached to (and, subsequently, the snapshot has been created from). Obviously this can only happen for attached volumes. If the script is executed regularly (such as via `cron`), however, going forward it'll be easier to identify the original purpose of abandoned volumes and snapshots.

To configure:

* add your AWS credentials to `config.json`, or give the instance you're running it from role-based permission to manage Volumes and Snapshots.
* add your AWS Owner ID in `volumes-and-snapshots.js`
* add the desired Slack channel and the Slack webhook URI in `volumes-and-snapshots.js` and `deletor.js` scripts; if you're not using Slack, you need to rip out or disable Slack functionality.

If using `cron`, modify `deletor.sh` and `volumes-and-snapshots.sh` scripts as needed, and use them to execute the node scripts. If you are using `nvm`, obtain the `node` version with `nvm which node`.