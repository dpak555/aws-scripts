#!/usr/bin/env bash

echo "Verifying that AWS CLI is installed ..."
command -v aws >/dev/null 2>&1 || { echo >&2 "AWS CLI tools are required, but couldn't be found. Please install from https://aws.amazon.com/cli/. Aborting."; exit 1; }

echo "Verifying that AWS CLI has configured credentials ..."
ORIGINAL_ACCESS_KEY_ID=$(aws configure get aws_access_key_id)
ORIGINAL_SECRET_ACCESS_KEY=$(aws configure get aws_secret_access_key)
if [ -z "$ORIGINAL_ACCESS_KEY_ID" ] ; then
  >&2 echo "ERROR: No aws_access_key_id/aws_secret_access_key configured for AWS CLI. Run 'aws configure' with your current keys."
  exit 1
fi

EXISTING_KEYS_CREATEDATES=0
EXISTING_KEYS_CREATEDATES=($(aws iam list-access-keys --query 'AccessKeyMetadata[].CreateDate' --output text))
NUM_EXISTING_KEYS=${#EXISTING_KEYS_CREATEDATES[@]}
if [ ${NUM_EXISTING_KEYS} -lt 2 ]; then
  echo "You have only one existing key. Now proceeding with new key creation."

else
  echo "You have two keys (maximum number). We must make space ..."

  IFS=$'\n' sorted_createdates=($(sort <<<"${EXISTING_KEYS_CREATEDATES[*]}"))
  unset IFS

  echo "Now aqcuiring data for the older key ..."
  OLDER_KEY_CREATEDATE="${sorted_createdates[0]}"
  OLDER_KEY_ID=$(aws iam list-access-keys --query "AccessKeyMetadata[?CreateDate=='${OLDER_KEY_CREATEDATE}'].AccessKeyId" --output text)
  OLDER_KEY_STATUS=$(aws iam list-access-keys --query "AccessKeyMetadata[?CreateDate=='${OLDER_KEY_CREATEDATE}'].Status" --output text)

  echo "Now aqcuiring data for the newer key ..."
  NEWER_KEY_CREATEDATE="${sorted_createdates[1]}"
  NEWER_KEY_ID=$(aws iam list-access-keys --query "AccessKeyMetadata[?CreateDate=='${NEWER_KEY_CREATEDATE}'].AccessKeyId" --output text)
  NEWER_KEY_STATUS=$(aws iam list-access-keys --query "AccessKeyMetadata[?CreateDate=='${NEWER_KEY_CREATEDATE}'].Status" --output text)

  key_in_use=""
  allow_older_key_delete=false
  allow_newer_key_delete=false
  if [ ${OLDER_KEY_STATUS} = "Active" ] &&
     [ ${NEWER_KEY_STATUS} = "Active" ] &&
     [ "${NEWER_KEY_ID}" = "${ORIGINAL_ACCESS_KEY_ID}" ]; then
    # both keys are active, newer key is in use
    key_in_use="newer"
    allow_older_key_delete=true
    key_id_can_delete=$OLDER_KEY_ID
    key_id_remaining=$NEWER_KEY_ID
  elif [ ${OLDER_KEY_STATUS} = "Active" ] &&
       [ ${NEWER_KEY_STATUS} = "Active" ] &&
       [ "${OLDER_KEY_ID}" = "${ORIGINAL_ACCESS_KEY_ID}" ]; then
    # both keys are active, older key is in use 
    key_in_use="older"
    allow_newer_key_delete=true
    key_id_can_delete=$NEWER_KEY_ID
    key_id_remaining=$OLDER_KEY_ID
  elif [ ${OLDER_KEY_STATUS} = "Inactive" ] &&
       [ ${NEWER_KEY_STATUS} = "Active" ]; then
    # newer key is active and in use
    key_in_use="newer"
    allow_older_key_delete=true
    key_id_can_delete=$OLDER_KEY_ID
    key_id_remaining=$NEWER_KEY_ID
  elif [ ${OLDER_KEY_STATUS} = "Active" ] &&
       [ ${NEWER_KEY_STATUS} = "Inactive" ]; then
    # older key is active and in use
    key_in_use="older"
    allow_newer_key_delete=true
    key_id_can_delete=$NEWER_KEY_ID
  else
    echo "You don't have keys I can delete to make space for the new key. Please delete a key manually and then try again."
    echo "Aborting."
    exit 1
  fi

fi

if [ "${allow_older_key_delete}" = "true" ] ||
   [ "${allow_newer_key_delete}" = "true" ]; then
  echo "To proceed you must delete one of your two existing keys; they are listed below:"
  echo
  echo "OLDER EXISTING KEY (${OLDER_KEY_STATUS}, created on ${OLDER_KEY_CREATEDATE}):"
  echo -n "Key Access ID: ${OLDER_KEY_ID} "
  if [ "${allow_older_key_delete}" = "true" ]; then 
    echo "(this key can be deleted)" 
  elif [ "${key_in_use}" = "older" ]; then
    echo "(this key is currently your active key)"
  fi
  echo
  echo "NEWER EXISTING KEY (${NEWER_KEY_STATUS}, created on ${NEWER_KEY_CREATEDATE}):"
  echo -n "Key Access ID: ${NEWER_KEY_ID} "
  if [ "${allow_newer_key_delete}" = "true" ]; then 
    echo "(this key can be deleted)"
  elif [ "${key_in_use}" = "newer" ]; then
    echo "(this key is currently your active key)"
  fi
  echo
  echo
  echo "Enter below the Access Key ID of the key to delete, or leave empty to cancel, then press enter." 
  read key_in

  if [ "${key_in}" = "${key_id_can_delete}" ]; then
    echo "Now deleting the key ${key_id_can_delete}"
    aws iam delete-access-key --access-key-id "${key_id_can_delete}"
    if [ $? -ne 0 ]; then
      echo "Could not delete the access keyID ${key_id_can_delete}. Cannot proceed."
      echo "Aborting."
      exit 1
    fi
  elif [ "${key_in}" = "" ]; then
    echo Aborting.
    exit 1
  else
    echo "The input did not match the Access Key ID of the key that can be deleted. Run the script again to retry."
    echo "Aborting."
    exit 1
  fi
fi

echo
echo "Creating a new access key for the current IAM user ..."
NEW_KEY_RAW_OUTPUT=$(aws iam create-access-key --output text)
NEW_KEY_DATA=($(printf '%s' "${NEW_KEY_RAW_OUTPUT}" | awk {'printf ("%5s\t%s", $2, $4)'}))
NEW_AWS_ACCESS_KEY_ID="${NEW_KEY_DATA[0]}"
NEW_AWS_SECRET_ACCESS_KEY="${NEW_KEY_DATA[1]}"

echo "Verifying that the new key was created ..."
EXISTING_KEYS_ACCESS_IDS=($(aws iam list-access-keys --query 'AccessKeyMetadata[].AccessKeyId' --output text))
NUM_EXISTING_KEYS=${#EXISTING_KEYS_ACCESS_IDS[@]}
if [ ${NUM_EXISTING_KEYS} -lt 2 ]; then
  >&2 echo "Something went wrong; the new key was not created."
  echo "Aborting"
  exit 1
fi

echo "Pausing to wait for the IAM changes to propagate ..."
COUNT=0
MAX_COUNT=20
SUCCESS=false
while [ "$SUCCESS" = false ] && [ "$COUNT" -lt "$MAX_COUNT" ]; do
  sleep 10
  aws iam list-access-keys > /dev/null && RETURN_CODE=$? || RETURN_CODE=$?
  if [ "$RETURN_CODE" -eq 0 ]; then
    SUCCESS=true
  else
    COUNT=$((COUNT+1))
    echo "(Still waiting for the key propagation to complete ...)"
  fi
done
echo "Key propagation complete."
echo "Configuring new access key for AWS CLI ..."
aws configure set aws_access_key_id "$NEW_AWS_ACCESS_KEY_ID"
aws configure set aws_secret_access_key "$NEW_AWS_SECRET_ACCESS_KEY"

echo "Verifying the new key is in place, and that IAM access still works ..."
revert=false
CONFIGURED_ACCESS_KEY=$(aws configure get aws_access_key_id)
if [ "$CONFIGURED_ACCESS_KEY" != "$NEW_AWS_ACCESS_KEY_ID" ]; then
  >&2 echo "Something went wrong; the new key could not be taken into use."
  revert=true
fi

# this is just to test access via AWS CLI; the content here doesn't matter (other than that we get a result)
EXISTING_KEYS_ACCESS_IDS=($(aws iam list-access-keys --query 'AccessKeyMetadata[].AccessKeyId' --output text))
NUM_EXISTING_KEYS=${#EXISTING_KEYS_ACCESS_IDS[@]}
if [ ${NUM_EXISTING_KEYS} -ne 2 ]; then
  >&2 echo "Something went wrong; the new key could not access AWS CLI."
  revert=true
fi

if [ "${revert}" = "true" ]; then
  echo "Reverting configuration to use the old keys."
  aws configure set aws_access_key_id "$ORIGINAL_ACCESS_KEY_ID"
  aws configure set aws_secret_access_key "$ORIGINAL_SECRET_ACCESS_KEY"
  echo "Original configuration restored."
  echo "Aborting."
  exit 1
fi

echo "Deleting the previously active access key ..."
aws iam delete-access-key --access-key-id "$ORIGINAL_ACCESS_KEY_ID"

echo "Verifying old access key got deleted ..."
# this is just to test access via AWS CLI; the content here doesn't matter (other than that we get a result)
EXISTING_KEYS_ACCESS_IDS=($(aws iam list-access-keys --query 'AccessKeyMetadata[].AccessKeyId' --output text))
NUM_EXISTING_KEYS=${#EXISTING_KEYS_ACCESS_IDS[@]}
if [ ${NUM_EXISTING_KEYS} -ne 1 ]; then
  >&2 echo "Something went wrong deleting the old key, however your new key is now in use."
fi
echo
echo "Successfully switched from the old access key ${ORIGINAL_ACCESS_KEY_ID} to ${NEW_AWS_ACCESS_KEY_ID}"
echo "Process complete."
