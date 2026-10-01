<#
.SYNOPSIS
  Notes for provisioning a Teams resource account / ACS number for the demo.
.DESCRIPTION
  This sample is safe-by-default and runs offline. For live outbound dialing, create an ACS phone number, set ACS_CALLER_ID, configure Event Grid to /api/events, expose PUBLIC_BASE_URL, and optionally assign a Teams Phone extensibility resource account. Keep CAMPAIGN_ENABLED=false until ALLOWED_TEST_NUMBERS contains only presenter-owned test phones.
#>
Write-Host "Provision ACS Call Automation, Event Grid, and optional Teams Phone extensibility resources per README.md."
