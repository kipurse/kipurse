#!/bin/bash
# Build a Release archive for TestFlight on the Mac (team YOUR_TEAM_ID, bundle com.blessbridge.kipurse.app). Does NOT upload.
# Upload is a separate, owner-approved step: open the .xcarchive in Xcode Organizer → Distribute App → App Store Connect → Upload.
set -euo pipefail
cd "$(dirname "$0")/.."
xcodegen generate >/dev/null
xcodebuild -project Kipurse.xcodeproj -scheme Kipurse -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Kipurse.xcarchive -allowProvisioningUpdates archive | tail -3
xcodebuild -exportArchive -archivePath build/Kipurse.xcarchive -exportOptionsPlist AppStore/ExportOptions-AppStore.plist \
  -exportPath build/export -allowProvisioningUpdates | tail -3
echo "IPA ready: build/export/Kipurse.ipa (not uploaded)"
