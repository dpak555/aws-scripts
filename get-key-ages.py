import boto3, json, time, datetime, sys

client = boto3.client('iam')
users = client.list_users()

for user in users['Users']:
	for key, value in user.iteritems() :
		if key == 'UserName' :

			res = client.list_access_keys(UserName = value)

			test_key1 = 'AccessKeyMetadata'
			test_key2 = 'CreateDate'
			if test_key1 in res:
				if len(res['AccessKeyMetadata']) > 0:
					if test_key2 in res['AccessKeyMetadata'][0]:

						users_groups = client.list_groups_for_user(UserName = value);

						# print user name
						print value,
						print '\t',

						test_key1 = 'Groups'
						test_key2 = 'GroupName'
						if test_key1 in users_groups:
							if len(users_groups['Groups']) > 0:
								if test_key2 in users_groups['Groups'][0]:
									this_group = users_groups['Groups'][0]['GroupName']
									this_group.replace(" ", "")
									if this_group != '':
										print this_group,
									else:
										print 'none',
								else:
									print 'none',
							else:
								print 'none',
						else:
							print 'none',
									
						print '\t',

						accesskeydate = res['AccessKeyMetadata'][0]['CreateDate'] # This may need to be looped if user has multiple keys
						accesskeydate = accesskeydate.strftime("%Y-%m-%d %H:%M:%S")
						currentdate = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())

						accesskeyd = time.mktime(datetime.datetime.strptime(accesskeydate, "%Y-%m-%d %H:%M:%S").timetuple())
						currentd = time.mktime(datetime.datetime.strptime(currentdate, "%Y-%m-%d %H:%M:%S").timetuple())

						active_days = (currentd - accesskeyd)/60/60/24 # Convert from days to seconds
						print (int(round(active_days)))

