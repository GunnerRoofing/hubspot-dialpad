#!/bin/bash
set -e

FUNCTION_NAME="hubspot-dialpad-webhook"
REGION="us-east-2"

echo "Zipping..."
zip -r function.zip index.js node_modules/ package.json

echo "Deploying to Lambda..."
aws lambda update-function-code \
  --function-name $FUNCTION_NAME \
  --zip-file fileb://function.zip \
  --region $REGION

echo "Cleaning up..."
rm function.zip

echo "Done."
