<#
.SYNOPSIS
  Binds a Teams resource account to this sample's ACS resource so inbound calls
  arrive under Teams Phone extensibility.

.DESCRIPTION
  Teams Phone extensibility routes a call like this:

    PSTN caller
      -> Teams service number
      -> Teams resource account   (ApplicationId = your calling bot,
                                   AcsResourceId = your ACS immutable ID)
      -> linked ACS resource
      -> Microsoft.Communication.IncomingCall on Event Grid
      -> this sample answers with Call Automation

  This script performs the Teams side of that binding and then reads back the
  Microsoft Entra object IDs you paste into config/routes.json as transfer targets.

  It does NOT buy a phone number, and it cannot make one appear. See PREREQUISITES.

.PARAMETER AcsImmutableResourceId
  The ACS *immutable* resource ID — a GUID. This is not the resource name and not
  the ARM path. Get it with:

    az communication show -g <rg> -n <acs> --query immutableResourceId -o tsv

.PARAMETER BotApplicationId
  The Entra application (client) ID of your calling bot. The resource account is
  created against this, which is what makes it yours rather than a first-party
  Auto Attendant or Call Queue.

.PARAMETER InboundResourceAccountUpn
  The resource account that owns the number people dial to reach this sample.

.EXAMPLE
  ./provision-teams-phone.ps1 `
    -AcsImmutableResourceId "8e1f2c34-..." `
    -BotApplicationId "1b9e77aa-..." `
    -InboundResourceAccountUpn "voicebot@contoso.com"

.NOTES
  PREREQUISITES — the one that blocks most people is the number.

  Teams Phone extensibility requires a *Teams service number* on the resource
  account. It must come from Microsoft Calling Plan, Operator Connect, or Direct
  Routing. A phone number purchased in Azure Communication Services CANNOT be
  assigned to a Teams resource account, and there is no cmdlet or portal path
  that converts one. If you only hold an ACS number, calls to it still reach this
  sample as ordinary Call Automation calls, but without the Teams resource
  account identity — the sample logs that arrival as "acs-direct".

  Acquiring a Microsoft number additionally requires at least one Calling Plan
  licence somewhere in the tenant; toll-free also needs funded pay-as-you-go
  billing. PHONESYSTEM_VIRTUALUSER alone is not sufficient to acquire a number,
  though it is the correct (free) licence for the resource account itself.

  Run as a Teams Administrator or Global Administrator, plus User Administrator
  for the licence assignment.

  References:
  https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-faq
  https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-quickstart
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
  [string] $InboundResourceAccountUpn,

  # Optional. Assigns the Teams service number to the resource account, if you
  # already hold one. Omit if the number is assigned separately.
  [string] $TelephoneNumber,

  [ValidateSet("CallingPlan", "OperatorConnect", "DirectRouting")]
  [string] $NumberType = "CallingPlan",

  # Where transferred callers end up. Defaults match the routes in routes.json.
  [string[]] $TransferTargetUpns = @(
    "sales-queue@contoso.com",
    "support-queue@contoso.com",
    "billing-queue@contoso.com",
    "reception-queue@contoso.com"
  )
)

$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------- 1. connect
if (-not (Get-Module -ListAvailable -Name MicrosoftTeams)) {
  Write-Host "Installing the MicrosoftTeams module..." -ForegroundColor Cyan
  Install-Module MicrosoftTeams -Scope CurrentUser -Force -AllowClobber
}
Import-Module MicrosoftTeams

Write-Host "Sign in as a Teams or Global Administrator..." -ForegroundColor Cyan
Connect-MicrosoftTeams | Out-Null

# ------------------------------------------- 2. the inbound resource account
# This is the Teams Phone extensibility binding. Set-CsTeamsAcsFederationConfiguration
# is a different feature — it lets ACS *users* talk to Teams users, and does nothing
# for phone extensibility.
Write-Host "`nBinding '$InboundResourceAccountUpn' to ACS resource $AcsImmutableResourceId..." -ForegroundColor Cyan

$inbound = Get-CsOnlineApplicationInstance -Identity $InboundResourceAccountUpn -ErrorAction SilentlyContinue
if (-not $inbound) {
  Write-Host "  creating the resource account..." -ForegroundColor DarkGray
  New-CsOnlineApplicationInstance `
    -UserPrincipalName $InboundResourceAccountUpn `
    -DisplayName "Intent-Based Call Routing" `
    -ApplicationId $BotApplicationId | Out-Null

  # Directory replication is not instant, and the next cmdlet needs the object.
  for ($i = 0; $i -lt 12 -and -not $inbound; $i++) {
    Start-Sleep -Seconds 5
    $inbound = Get-CsOnlineApplicationInstance -Identity $InboundResourceAccountUpn -ErrorAction SilentlyContinue
  }
  if (-not $inbound) { throw "Resource account did not appear after 60s. Re-run this script; creation may still be replicating." }
}

Set-CsOnlineApplicationInstance `
  -Identity $InboundResourceAccountUpn `
  -ApplicationId $BotApplicationId `
  -AcsResourceId $AcsImmutableResourceId

Sync-CsOnlineApplicationInstance `
  -ObjectId $inbound.ObjectId `
  -ApplicationId $BotApplicationId

Write-Host "  bound. Object ID: $($inbound.ObjectId)" -ForegroundColor Green
Write-Host "  inbound calls will arrive with to.rawId = 28:orgid:$($inbound.ObjectId)" -ForegroundColor DarkGray

# ------------------------------------------------------------- 3. the number
if ($TelephoneNumber) {
  Write-Host "`nAssigning $TelephoneNumber ($NumberType)..." -ForegroundColor Cyan
  try {
    Set-CsPhoneNumberAssignment `
      -Identity $InboundResourceAccountUpn `
      -TelephoneNumber $TelephoneNumber `
      -NumberType $NumberType
    Write-Host "  assigned." -ForegroundColor Green
  }
  catch {
    Write-Warning "Could not assign the number: $($_.Exception.Message)"
    Write-Warning "Confirm it is a Teams *service* number and that the resource account holds a Microsoft Teams Phone Resource Account licence."
  }
}
else {
  Write-Host "`nNo -TelephoneNumber given. The resource account has no number until one is assigned." -ForegroundColor Yellow
  Write-Host "Reminder: it must be a Teams service number. An ACS-purchased number cannot be used here." -ForegroundColor Yellow
}

# --------------------------------------------- 4. read back the transfer targets
Write-Host "`nResolving transfer targets. Paste these into config/routes.json:`n" -ForegroundColor Cyan

$rows = foreach ($upn in $TransferTargetUpns) {
  try {
    $account = Get-CsOnlineApplicationInstance -Identity $upn -ErrorAction Stop
    [pscustomobject]@{
      ResourceAccount = $upn
      ObjectId        = $account.ObjectId
      # 11cd3e2e-fccb-42ad-ad00-878b93575e07 = call queue
      # ce933385-9390-45d1-9512-c8d228074e07 = auto attendant
      Kind            = switch ($account.ApplicationId) {
        "11cd3e2e-fccb-42ad-ad00-878b93575e07" { "callQueue" }
        "ce933385-9390-45d1-9512-c8d228074e07" { "autoAttendant" }
        default { "unknown" }
      }
    }
  }
  catch {
    [pscustomobject]@{ ResourceAccount = $upn; ObjectId = "NOT FOUND"; Kind = "-" }
  }
}

$rows | Format-Table -AutoSize

if ($rows | Where-Object { $_.ObjectId -eq "NOT FOUND" }) {
  Write-Warning "Some transfer targets were not found. Create them with New-CsOnlineApplicationInstance, assign a Microsoft Teams Phone Resource Account licence, and associate each with its call queue using New-CsOnlineApplicationInstanceAssociation."
}

Write-Host @"

Remaining steps, on the Azure side:

  1. Grant ACS server consent for this resource account:

       PUT https://<acs-host>/access/teamsExtension/tenants/<tenant-id>/assignments/$($inbound.ObjectId)?api-version=2025-06-30
       { "principalType": "teamsResourceAccount" }

     Setting -AcsResourceId above is only the Teams half of the binding.

  2. Point an Event Grid subscription on the ACS resource at this sample:

       az eventgrid event-subscription create \
         --name tpe-incoming-call \
         --source-resource-id <acs-arm-resource-id> \
         --endpoint-type webhook \
         --endpoint https://<your-host>/api/events \
         --included-event-types Microsoft.Communication.IncomingCall

  3. Set the calling webhook on your Azure Bot to https://eventgrid.azure.net
     so Teams delivers calls through Event Grid.

  4. Start the sample and check GET /health — telephony and teams should both
     report ready before you dial.

"@ -ForegroundColor Cyan
