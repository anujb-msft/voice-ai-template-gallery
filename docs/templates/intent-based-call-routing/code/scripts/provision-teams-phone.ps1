<#
.SYNOPSIS
  Prepares a Teams tenant to receive transferred calls from this sample.

.DESCRIPTION
  Azure Communication Services cannot transfer a call into a Teams tenant until that
  tenant explicitly federates with the ACS resource. This script performs that
  authorisation and then reads back the Microsoft Entra object IDs you need to paste
  into config/routes.json.

  Run it once, as a Teams Administrator or Global Administrator.

.EXAMPLE
  ./provision-teams-phone.ps1 -AcsResourceId "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Communication/CommunicationServices/<acs>"

.NOTES
  Federation is tenant-wide and additive. Running this twice is harmless; the existing
  allow list is read first and the new resource is appended to it.

  Reference:
  https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation
#>

[CmdletBinding()]
param(
  # The full Azure resource ID of your Communication Services resource.
  [Parameter(Mandatory = $true)]
  [string] $AcsResourceId,

  # Resource accounts of the call queues and auto attendants you want to route to.
  # Defaults match the four routes shipped in config/routes.json.
  [string[]] $ResourceAccountUpns = @(
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

# ------------------------------------------------------------------ 2. federation
# Extract the ACS immutable resource ID. Federation is configured with the resource's
# GUID, which is the last segment of the ARM resource ID.
$acsGuid = ($AcsResourceId.TrimEnd('/') -split '/')[-1]

Write-Host "`nAuthorising ACS resource '$acsGuid' to interoperate with this tenant..." -ForegroundColor Cyan

$config = Get-CsTeamsAcsFederationConfiguration -Identity Global
$allowed = @()
if ($config.AllowedAcsResources) { $allowed = @($config.AllowedAcsResources) }

if ($allowed -contains $acsGuid) {
  Write-Host "  already federated." -ForegroundColor DarkGray
}
else {
  $allowed += $acsGuid
  Set-CsTeamsAcsFederationConfiguration -Identity Global `
    -EnableAcsUsers $true `
    -AllowedAcsResources $allowed
  Write-Host "  federation enabled. Tenant-wide policy changes can take up to 30 minutes." -ForegroundColor Green
}

# --------------------------------------------------- 3. read back the object IDs
Write-Host "`nResolving resource accounts. Paste these into config/routes.json:`n" -ForegroundColor Cyan

$rows = foreach ($upn in $ResourceAccountUpns) {
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
  Write-Warning "Some resource accounts were not found. Create them with New-CsOnlineApplicationInstance, assign a Microsoft Teams Phone Resource Account licence, and associate each with its call queue."
}

Write-Host @"

Remaining steps, which this script deliberately does not automate:

  1. Put each ObjectId above into the matching route's target.objectId in
     config/routes.json, and set target.type to the Kind shown.
  2. Buy or port a PSTN number on the ACS resource. That is the number callers dial;
     it does not need to exist in Teams.
  3. Expose this server over HTTPS  ->  npm run tunnel
  4. Create an Event Grid system topic on the ACS resource with a webhook
     subscription to  <PUBLIC_BASE_URL>/api/events  filtered to the
     Microsoft.Communication.IncomingCall event type. The server answers the
     subscription validation handshake on its own.
  5. Call the number.

"@ -ForegroundColor Cyan
