<#
Illustrative provisioning notes for Teams Phone extensibility.
Replace IDs and resource names for your tenant before running.
#>
param(
  [string]$ResourceAccountObjectId = "00000000-0000-0000-0000-000000000311",
  [string]$AcsEndpoint = "https://contoso-acs.unitedstates.communication.azure.com",
  [string]$PublicBaseUrl = "https://contoso-311.example.com"
)
Write-Host "Link the Teams Phone resource account $ResourceAccountObjectId to ACS $AcsEndpoint"
Write-Host "Configure Event Grid IncomingCall webhook: $PublicBaseUrl/api/events"
Write-Host "Configure Call Automation callback: $PublicBaseUrl/api/calls/callback"
Write-Host "Verify department queue object IDs in config/departments.json before live transfer tests."
