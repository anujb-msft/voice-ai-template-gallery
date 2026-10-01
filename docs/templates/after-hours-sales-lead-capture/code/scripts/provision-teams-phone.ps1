param(
  [Parameter(Mandatory=$true)][string]$AcsEndpoint,
  [Parameter(Mandatory=$true)][string]$PublicBaseUrl,
  [Parameter(Mandatory=$true)][string]$SalesQueueApplicationId
)
Write-Host "After-Hours Sales Lead Capture provisioning checklist"
Write-Host "1. Link the Teams Phone resource account to ACS Teams Phone extensibility."
Write-Host "2. Create Event Grid subscription for IncomingCall to $PublicBaseUrl/api/events."
Write-Host "3. Set config/hours.json salesQueue.objectId to $SalesQueueApplicationId."
Write-Host "4. Set ACS_ENDPOINT=$AcsEndpoint and PUBLIC_BASE_URL=$PublicBaseUrl in .env."
