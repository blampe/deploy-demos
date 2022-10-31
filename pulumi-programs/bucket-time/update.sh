#!/bin/bash

curl -L "https://api.pulumi.com/api/preview/pulumi/bucket-time/ced/deployments" \
  -H "Authorization: token $PULUMI_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
          \"sourceContext\": {
            \"git\": {
              \"repoURL\": \"https://github.com/pulumi/deploy-demos\",
              \"branch\": \"refs/heads/ced\",
              \"repoDir\": \"pulumi-programs/bucket-time\"
            }
          },
          \"operationContext\": {
            \"operation\": \"update\",
            \"preRunCommands\": [
              \"echo 'hello world'\"
            ],
            \"environmentVariables\": {
              \"AWS_REGION\": \"us-west-2\",
              \"AWS_ACCESS_KEY_ID\": \"$AWS_ACCESS_KEY_ID\",
              \"AWS_SECRET_ACCESS_KEY\": \"$AWS_SECRET_ACCESS_KEY\",
              \"AWS_SESSION_TOKEN\": \"$AWS_SESSION_TOKEN\"
            }
          }
        }"