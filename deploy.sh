#!/bin/bash
set -e

FUNCTION_NAME="hubspot-dialpad-webhook"
REGION="us-east-2"

echo "Zipping..."
rm -f function.zip
zip -r function.zip index.js contactIdentity.js smsPolicy.js busMap.js node_modules/ package.json

echo "Deploying to Lambda..."
aws lambda update-function-code \
  --function-name $FUNCTION_NAME \
  --zip-file fileb://function.zip \
  --region $REGION \
  --query '{FunctionName:FunctionName,LastModified:LastModified,CodeSha256:CodeSha256,CodeSize:CodeSize}' \
  --output json

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query 'LastUpdateStatus'

echo "Updating Lambda runtime..."
aws lambda update-function-configuration \
  --function-name "$FUNCTION_NAME" \
  --runtime nodejs24.x \
  --region "$REGION" \
  --query '{FunctionName:FunctionName,Runtime:Runtime,LastUpdateStatus:LastUpdateStatus}' \
  --output json

aws lambda wait function-updated \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --query 'LastUpdateStatus'

echo "Cleaning up..."
rm function.zip

echo "Done."
