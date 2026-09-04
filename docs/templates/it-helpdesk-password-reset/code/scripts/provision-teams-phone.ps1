<#
.SYNOPSIS
  Binds a Teams resource account to this sample's ACS resource for outbound
  Teams Phone extensibility calls.

.DESCRIPTION
  The password-reset server places a PSTN callback through ACS Call Automation
  and sets the Teams resource account as teamsAppSource. The employee sees the
  Teams service number assigned to that resource account as the caller ID.

  This script performs the Teams-side resource-account binding and can assign a
  service number that the tenant already owns. It does not acquire a number,
  grant ACS server consent, or configure Azure billing.

.PARAMETER AcsImmutableResourceId
  The ACS immutable resource ID. Get it with:

    az communication show -g <resource-group> -n <acs-name> `
      --query immutableResourceId -o tsv

.PARAMETER BotApplicationId
  The Entra application (client) ID of the calling bot.

.PARAMETER ResourceAccountUpn
  The UPN for the Teams resource account used as the outbound caller.

.EXAMPLE
  ./provision-teams-phone.ps1 `
    -AcsImmutableResourceId "8e1f2c34-..." `
    -BotApplicationId "1b9e77aa-..." `
    -ResourceAccountUpn "password-reset@contoso.com" `
    -TelephoneNumber "+14255550100"

.NOTES
  The assigned number must be a Teams service number from Calling Plan,
  Operator Connect, or Direct Routing. An ACS-purchased number cannot be
  assigned to a Teams resource account.

  For Calling Plan outbound calls, verify the current Pay-As-You-Go Calling
  Plan requirement before testing. Operator Connect requirements depend on the
  carrier; Direct Routing requires the appropriate voice routing policy.

  References:
  https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-quickstart
  https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-server-outbound-call
  https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-faq
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string] $AcsImmutableResourceId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F-]{36}$')]
  [string] $BotApplicationId,

  [Parameter(Mandatory = $true)]
  [string] $ResourceAccountUpn,

  [string] $TelephoneNumber,

  [ValidateSet("CallingPlan", "OperatorConnect", "DirectRouting")]
  [string] $NumberType = "CallingPlan"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Module -ListAvailable -Name MicrosoftTeams)) {
  throw "Install the MicrosoftTeams PowerShell module before running this script."
}

Import-Module MicrosoftTeams
Write-Host "Sign in as a Teams or Global Administrator..." -ForegroundColor Cyan
Connect-MicrosoftTeams | Out-Null

Write-Host "`nBinding '$ResourceAccountUpn' to ACS resource $AcsImmutableResourceId..." -ForegroundColor Cyan

$account = Get-CsOnlineApplicationInstance `
  -Identity $ResourceAccountUpn `
  -ErrorAction SilentlyContinue

if (-not $account) {
  Write-Host "  creating the Teams resource account..." -ForegroundColor DarkGray
  New-CsOnlineApplicationInstance `
    -UserPrincipalName $ResourceAccountUpn `
    -DisplayName "IT Help Desk Password Reset" `
    -ApplicationId $BotApplicationId | Out-Null

  for ($i = 0; $i -lt 12 -and -not $account; $i++) {
    Start-Sleep -Seconds 5
    $account = Get-CsOnlineApplicationInstance `
      -Identity $ResourceAccountUpn `
      -ErrorAction SilentlyContinue
  }
  if (-not $account) {
    throw "Resource account did not appear after 60 seconds. Re-run after directory replication completes."
  }
}

Set-CsOnlineApplicationInstance `
  -Identity $ResourceAccountUpn `
  -ApplicationId $BotApplicationId `
  -AcsResourceId $AcsImmutableResourceId

Sync-CsOnlineApplicationInstance `
  -ObjectId $account.ObjectId `
  -ApplicationId $BotApplicationId

Write-Host "  bound. Resource account object ID: $($account.ObjectId)" -ForegroundColor Green

if ($TelephoneNumber) {
  Write-Host "`nAssigning Teams service number $TelephoneNumber ($NumberType)..." -ForegroundColor Cyan
  Set-CsPhoneNumberAssignment `
    -Identity $ResourceAccountUpn `
    -TelephoneNumber $TelephoneNumber `
    -NumberType $NumberType
  Write-Host "  assigned." -ForegroundColor Green
}
else {
  Write-Warning "No service number was assigned. Set one before placing a TPE PSTN call."
}

Write-Host @"

Complete the Azure side before testing:

1. Grant this resource account ACS server consent:

   PUT https://<acs-host>/access/teamsExtension/tenants/<tenant-id>/assignments/$($account.ObjectId)?api-version=2025-06-30
   { "principalType": "teamsResourceAccount" }

2. Set these application values:

   TELEPHONY_MODE=teams-phone
   TPE_RESOURCE_ACCOUNT_ID=$($account.ObjectId)

3. Keep ACS_CALLER_ID empty or ignored in teams-phone mode.

4. Verify the service number has outbound PSTN connectivity and licensing.

5. Start the sample and check /health:

   "telephonyMode": "teams-phone"
   "callReady": true
   "missingCallConfig": []

"@ -ForegroundColor Cyan
