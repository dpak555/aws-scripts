#!/bin/bash

# Set the session length in seconds below;
# note that this only sets the client-side
# validity of the MFA session token; 
# the maximum length of a valid session
# is enforced in the IAM policy, and
# is unaffected by this value.
#
# The minimum valid session length
# is 900 seconds.
MFA_SESSION_LENGTH_IN_SECONDS=900

## PREREQUISITES CHECK

# `exists` for commands
exists() {
	command -v "$1" >/dev/null 2>&1
}

# is AWS CLI installed?
if ! exists aws ; then
	printf "\n******************************************************************************************************************************\n\
This script requires the AWS CLI. See the details here: http://docs.aws.amazon.com/cli/latest/userguide/cli-install-macos.html\n\
******************************************************************************************************************************\n\n"
	exit 1
fi 

# check for ~/.aws directory, and ~/.aws/{config|credentials} files
if [ ! -d ~/.aws ]; then
	echo
	echo -e "'~/.aws' directory not present.\nMake sure it exists, and that you have at least one profile configured\nusing the 'config' and 'credentials' files within that directory."
	echo
	exit 1
fi

if [[ ! -f ~/.aws/config && ! -f ~/.aws/credentials ]]; then
	echo
	echo -e "'~/.aws/config' and '~/.aws/credentials' files not present.\nMake sure they exist. See http://docs.aws.amazon.com/cli/latest/userguide/cli-config-files.html for details on how to set them up."
	echo
	exit 1
elif [ ! -f ~/.aws/config ]; then
	echo
	echo -e "'~/.aws/config' file not present.\nMake sure it and '~/.aws/credentials' files exists. See http://docs.aws.amazon.com/cli/latest/userguide/cli-config-files.html for details on how to set them up."
	echo
	exit 1
elif [ ! -f ~/.aws/credentials ]; then
	echo
	echo -e "'~/.aws/credentials' file not present.\nMake sure it and '~/.aws/config' files exists. See http://docs.aws.amazon.com/cli/latest/userguide/cli-config-files.html for details on how to set them up."
	echo
	exit 1
fi

CREDFILE=~/.aws/credentials
# check that at least one profile is configured
ONEPROFILE="false"
while IFS='' read -r line || [[ -n "$line" ]]; do
	[[ "$line" =~ ^\[(.*)\].* ]] &&
		profile_ident=${BASH_REMATCH[1]}

		if [ $profile_ident != "" ]; then
			ONEPROFILE="true"
		fi 
done < $CREDFILE


if [[ "$ONEPROFILE" = "false" ]]; then
	echo
	echo -e "NO CONFIGURED AWS PROFILES FOUND.\nPlease make sure you have '~/.aws/config' (profile configurations),\nand '~/.aws/credentials' (profile credentials) files, and at least\none configured profile. For more info, see AWS CLI documentation at:\nhttp://docs.aws.amazon.com/cli/latest/userguide/cli-config-files.html"
	echo

else

  # Check OS for some supported platforms
  OS="`uname`"
  case $OS in
    'Linux')
      OS='Linux'
      ;;
    'Darwin') 
      OS='macOS'
      ;;
    *) 
      OS='unknown'
      echo
      echo "** NOTE: THIS SCRIPT HAS NOT BEEN TESTED ON YOUR CURRENT PLATFORM."
      echo
      ;;
  esac

  # make sure ~/.aws/credentials has a linefeed in the end
  c=$(tail -c 1 "$CREDFILE")
  if [ "$c" != "" ]; then
    echo "" >> "$CREDFILE"
  fi

	## PREREQS PASSED; PROCEED..

	declare -a cred_profiles
	declare -a cred_profile_status
	declare -a cred_profile_user
	declare -a cred_profile_arn
	declare -a profile_region
	declare -a profile_output
	declare -a mfa_profiles
	declare -a mfa_arns
	declare -a mfa_profile_status
	cred_profilecounter=0

	echo "Please wait..."

	while IFS='' read -r line || [[ -n "$line" ]]; do
		[[ "$line" =~ ^\[(.*)\].* ]] &&
		profile_ident=${BASH_REMATCH[1]}

		# only process if profile identifier is present,
		# and if it's not a mfasession profile
		if [ "$profile_ident" != "" ] &&
	     ! [[ "$profile_ident" =~ -mfasession$ ]]; then

	       	cred_profiles[$cred_profilecounter]=$profile_ident

	       	profile_region[$cred_profilecounter]=$(aws --profile $profile_ident configure get region)
	       	profile_output[$cred_profilecounter]=$(aws --profile $profile_ident configure get output)

	       	# get user ARN; this should be always available
	        user_arn="$(aws sts get-caller-identity --profile $profile_ident --output text --query 'Arn' 2>&1)"
			if [[ "$user_arn" =~ ^arn:aws ]]; then
				cred_profile_arn[$cred_profilecounter]=$user_arn
			else
				cred_profile_arn[$cred_profilecounter]=""
			fi

			# get the actual username (may be different from the arbitrary profile ident)
	        [[ "$user_arn" =~ ([^/]+)$ ]] &&
		    profile_username="${BASH_REMATCH[1]}"
			if [[ "$profile_username" =~ error ]]; then
				cred_profile_user[$cred_profilecounter]=""
			else
				cred_profile_user[$cred_profilecounter]="$profile_username"
			fi

			# find existing MFA sessions for the current profile
			while IFS='' read -r line || [[ -n "$line" ]]; do
				[[ "$line" =~ \[(${profile_ident}-mfasession)\]$ ]] &&
				mfa_profile_ident="${BASH_REMATCH[1]}"
			done < $CREDFILE
			mfa_profiles[$cred_profilecounter]="$mfa_profile_ident"

			# check to see if this profile has access
			# (this is not 100% as it depends on IAM access)
			profile_check="$(aws iam get-user --output text --query "User.Arn" --profile $profile_ident 2>&1)"
			if [[ "$profile_check" =~ ^arn:aws ]]; then
				cred_profile_status[$cred_profilecounter]="OK"
			else
				cred_profile_status[$cred_profilecounter]="LIMITED"
			fi

			# get MFA ARN if available
			mfa_arn="$(aws iam list-virtual-mfa-devices --profile $profile_ident --output text --query "VirtualMFADevices[?User.Arn=='${user_arn}'].SerialNumber" 2>&1)"
			if [[ "$mfa_arn" =~ ^arn:aws ]]; then
				mfa_arns[$cred_profilecounter]="$mfa_arn"
			else
				mfa_arns[$cred_profilecounter]=""
			fi

			# if existing MFA profile was found, check its status
			# (this is not 100% as it depends on IAM access)
			if [ "$mfa_profile_ident" != "" ]; then
				mfa_profile_check="$(aws iam get-user --output text --query "User.Arn" --profile $mfa_profile_ident 2>&1)"
				if [[ "$mfa_profile_check" =~ ^arn:aws ]]; then
					mfa_profile_status[$cred_profilecounter]="OK"
				elif [[ "$mfa_profile_check" =~ ExpiredToken ]]; then
					mfa_profile_status[$cred_profilecounter]="EXPIRED"
				else
					mfa_profile_status[$cred_profilecounter]="LIMITED"
				fi
			fi

## DEBUG
#			echo "PROFILE IDENT: $profile_ident (${cred_profile_status[$cred_profilecounter]})"
#			echo "USER ARN: ${cred_profile_arn[$cred_profilecounter]}"
#			echo "USER NAME: ${cred_profile_user[$cred_profilecounter]}"
#			echo "MFA ARN: ${mfa_arns[$cred_profilecounter]}"
#			if [ "${mfa_profiles[$cred_profilecounter]}" == "" ]; then
#				echo "MFA PROFILE IDENT:"
#			else
#				echo "MFA PROFILE IDENT: ${mfa_profiles[$cred_profilecounter]} (${mfa_profile_status[$cred_profilecounter]})"
#			fi
#			echo

			# erase variables & increase iterator for the next iteration
			mfa_arn=""
			user_arn=""
	        profile_ident=""
	        profile_check=""
	        profile_username=""
	        mfa_profile_ident=""
	        mfa_profile_check=""

			cred_profilecounter=$(($cred_profilecounter+1))

	    fi
	done < $CREDFILE

	# create profile selections
	echo "AVAILABLE AWS PROFILES:"
	echo
	SELECTR=0
	ITER=1
	for i in "${cred_profiles[@]}"
	do
		if [ "${mfa_arns[$SELECTR]}" != "" ]; then
			mfa_notify=", MFA configured"
		else
			mfa_notify="" 
		fi

		echo "${ITER}: $i (${cred_profile_user[$SELECTR]}${mfa_notify})"

		if [ "${mfa_profile_status[$SELECTR]}" = "OK" ] ||
		   [ "${mfa_profile_status[$SELECTR]}" = "LIMITED" ]; then
			echo "${ITER}m: $i MFA profile in ${mfa_profile_status[$SELECTR]} status"
		fi

		echo
		let ITER=${ITER}+1
		let SELECTR=${SELECTR}+1
	done

	# prompt for profile selection
	printf "SELECT A PROFILE BY THE ID: "
	read -r selprofile

	# process the selection
	if [ "$selprofile" != "" ]; then
		#capture the numeric part of the selection
	    [[ $selprofile =~ ^([[:digit:]]+) ]] &&
	    selprofile_check="${BASH_REMATCH[1]}"
	    if [ "$selprofile_check" != "" ]; then

	    	# if the numeric selection was found, 
	    	# translate it to the array index and validate
	    	let actual_selprofile=${selprofile_check}-1

	    	profilecount=${#cred_profiles[@]}
	    	if [[ $actual_selprofile -ge $profilecount ||
	    		 $actual_selprofile -lt 0 ]]; then
	    		# a selection outside of the existing range was specified
	    		echo "There is no profile '${selprofile}'."
	    		echo
	    		exit 1
	    	fi

	    	# was an existing MFA profile selected?
		    [[ $selprofile =~ ^[[:digit:]]+(m)$ ]] &&
	    	selprofile_mfa_check="${BASH_REMATCH[1]}"

		    if [[ "$selprofile_mfa_check" != "" &&
		       ( "${mfa_profile_status[$actual_selprofile]}" = "OK" ||
	  			 "${mfa_profile_status[$actual_selprofile]}" = "LIMITED" ) ]]; then
				
				echo "SELECTED MFA PROFILE: ${mfa_profiles[$actual_selprofile]}"
				final_selection="${mfa_profiles[$actual_selprofile]}"

		    elif [[ "$selprofile_mfa_check" != "" &&
		            "${mfa_profile_status[$actual_selprofile]}" = "" ]]; then
		        # mfa ('m') profile was selected for a profile that no mfa profile exists
	    		echo "There is no profile '${selprofile}'."
	    		echo
	    		exit 1	           

			else
				# a base profile was selected
			    if [[ $selprofile =~ ^[[:digit:]]+$ ]]; then 
					echo "SELECTED PROFILE: ${cred_profiles[$actual_selprofile]}"
	 				final_selection="${cred_profiles[$actual_selprofile]}"
	 			else
	 				# non-acceptable characters were present in the selection
		    		echo "There is no profile '${selprofile}'."
		    		echo
		    		exit 1	           
	 			fi
		    fi
		    
	   	else
	   		# no numeric part in selection
	   		echo "There is no profile '${selprofile}'."
	   		echo
	   		exit 1
	    fi
	else 
		# empty selection
		echo "There is no profile '${selprofile}'."
		echo
		exit 1
	fi

	if [ "${mfa_arns[$actual_selprofile]}" != "" ]; then
		mfaprofile="true"
		# prompt for the MFA code since MFA has been configured for this profile
		echo
		echo -e "Enter the current MFA one time pass code for profile '${cred_profiles[$actual_selprofile]}' to start/renew an MFA session,\nor leave empty (just press [ENTER]) to use the selected profile as-is."
		while :
		do
  			read mfacode
			if ! [[ "$mfacode" =~ ^$ || "$mfacode" =~ [0-9]{6} ]]; then
				echo "The MFA code must be exactly six digits, or blank to bypass."
				continue
			else
				break
			fi
		done

	else
		mfaprofile="false"
		mfacode=""
		echo
		echo -e "MFA has not been set up for this profile."
	fi

	if [ "$mfacode" != "" ]; then

		# init the MFA session (request a MFA session token)
		AWS_USER_PROFILE=${cred_profiles[$actual_selprofile]}
		AWS_2AUTH_PROFILE=${AWS_USER_PROFILE}-mfasession
		ARN_OF_MFA=${mfa_arns[$actual_selprofile]}
		MFA_TOKEN_CODE=$mfacode
		DURATION=$MFA_SESSION_LENGTH_IN_SECONDS

		echo "GETTING AN MFA SESSION TOKEN FOR THE PROFILE: $AWS_USER_PROFILE"

		read AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN <<< \
		$( aws --profile $AWS_USER_PROFILE sts get-session-token \
		  --duration $DURATION \
		  --serial-number $ARN_OF_MFA \
		  --token-code $MFA_TOKEN_CODE \
		  --output text  | awk '{ print $2, $4, $5 }')

		if [ -z "$AWS_ACCESS_KEY_ID" ]; then
			echo
			echo "Could not initialize the requested MFA session."
			echo
			exit 1
		fi

## DEBUG
#		echo "AWS_ACCESS_KEY_ID: $AWS_ACCESS_KEY_ID"
#		echo "AWS_SECRET_ACCESS_KEY: $AWS_SECRET_ACCESS_KEY"
#		echo "AWS_SESSION_TOKEN: $AWS_SESSION_TOKEN"

		# set the temp aws_access_key_id, aws_secret_access_key, and aws_session_token for the MFA profile
		`aws --profile $AWS_2AUTH_PROFILE configure set aws_access_key_id "$AWS_ACCESS_KEY_ID"`
		`aws --profile $AWS_2AUTH_PROFILE configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY"`
		`aws --profile $AWS_2AUTH_PROFILE configure set aws_session_token "$AWS_SESSION_TOKEN"`

		# get the current region and output for the region (are they set?)
		get_region=$(aws --profile $AWS_2AUTH_PROFILE configure get region)
		get_output=$(aws --profile $AWS_2AUTH_PROFILE configure get output)

		# if the region and output were not set, use the base profile values for 
		# the MFA profiles (or deafults, if not set for the base, either)
		if [ "${get_region}" = "" ]; then
			if [ ${profile_region[$actual_selprofile]} != "" ]; then
				set_new_region=${profile_region[$actual_selprofile]}
				echo "Default region was not set for the MFA profile. It was set to same ('$set_new_region') as the base profile."
			else
				set_new_region="us-east-1"
				echo "Default region was not set for the MFA profile. It was set to the default 'us-east-1')."
			fi

			`aws --profile $AWS_2AUTH_PROFILE configure set region "${set_new_region}"`
		fi

		if [ "${get_output}" = "" ]; then
			if [ ${profile_output[$actual_selprofile]} != "" ]; then
				set_new_output=${profile_output[$actual_selprofile]}
				echo "Default output format was not set for the MFA profile. It was set to same ('$set_new_output') as the base profile."
			else
				set_new_region="json"
				echo "Default output format was not set for the MFA profile. It was set to the default 'json')."
			fi

			`aws --profile $AWS_2AUTH_PROFILE configure set output "${set_new_output}"`
		fi

		# Make sure the final selection profile name has '-mfasession' suffix
		# (it's not present when going from base profile to MFA profile)
		if ! [[ "$final_selection" =~ -mfasession$ ]]; then
			final_selection="${final_selection}-mfasession"
		fi

	fi

	# get region and output format for display (even when not entering MFA code)
	get_region=$(aws --profile $final_selection configure get region)
	get_output=$(aws --profile $final_selection configure get output)

	echo
	if [[ "$mfaprofile" = "true" && "$mfacode" != "" ]]; then
		echo "MFA profile name: '${final_selection}'"
		echo
	else
		echo "Profile name '${final_selection}'"
		echo "** NOTE: This is not an MFA session!"
		echo 
	fi
	echo "Region is set to: $get_region"
	echo "Output format is set to: $get_output"
	echo
	if [ "$OS" = "macOS" ]; then
		echo "Execute the following in Terminal to activate this profile:"
		echo
		echo "export AWS_PROFILE=${final_selection}"
		echo
		echo -n "export AWS_PROFILE=${final_selection}" | pbcopy
		echo "(the activation command is now on your clipboard -- just paste in Terminal, and press [ENTER])"
	elif [ "$OS" = "Linux" ]; then
		echo "Execute the following on the command line to activate this profile:"
		echo
		echo "export AWS_PROFILE=${final_selection}"
		echo
		if exists xclip ; then
			echo -n "export AWS_PROFILE=${final_selection}" | xclip -i
			echo "(xclip found; the activation command is now on your X PRIMARY clipboard -- just paste on the command line, and press [ENTER])"
		else
			echo "If you're using an X GUI on Linux, install 'xclip' to have the activation command copied to the clipboard automatically."
		fi
	else
		echo "Execute the following on the command line to activate this profile:"
		echo
		echo "export AWS_PROFILE=${final_selection}" 
	fi
	echo

fi
