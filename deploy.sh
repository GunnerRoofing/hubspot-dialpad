#!/bin/bash
set -e

FUNCTION_NAME="hubspot-dialpad-webhook"
REGION="us-east-2"

echo "Zipping..."
zip -r function.zip index.js contactIdentity.js busMap.js node_modules/ package.json

echo "Deploying to Lambda..."
aws lambda update-function-code \
  --function-name $FUNCTION_NAME \
  --zip-file fileb://function.zip \
  --region $REGION \
  --query '{FunctionName:FunctionName,LastModified:LastModified,CodeSha256:CodeSha256,CodeSize:CodeSize}' \
  --output json

echo "Cleaning up..."
rm function.zip

echo "Done."
