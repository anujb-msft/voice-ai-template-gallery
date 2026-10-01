<#
Demo provisioning checklist for the Contextual On-Call Pager sample.
This does not mutate tenant resources by default; it records the commands an admin runs
when connecting a Teams Phone resource account to ACS Teams Phone extensibility.
#>
param(
  [Parameter(Mandatory=$true)][string]$ResourceAccountUpn,
  [Parameter(Mandatory=$true)][string]$AcsResourceId,
  [Parameter(Mandatory=$true)][string]$PublicBaseUrl
)

Write-Host "1. Assign the Teams Phone number to $ResourceAccountUpn"
Write-Host "2. Enable Teams Phone extensibility and link ACS resource $AcsResourceId"
Write-Host "3. Configure Event Grid IncomingCall webhook: $PublicBaseUrl/api/events"
Write-Host "4. Configure ACS callback URL: $PublicBaseUrl/api/calls/callback"
Write-Host "5. Verify ACS_OUTBOUND_CALLER_ID presents the same service number for outbound pages."
