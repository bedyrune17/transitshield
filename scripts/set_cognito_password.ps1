# Set a permanent password for a TransitShield Cognito user WITHOUT email.
# Use when the invitation email does not arrive (e.g. filtered by a
# university mail system). The password is typed at a hidden prompt; it is
# never echoed, logged or written to disk.
#
# Usage (PowerShell 7):
#   & .\scripts\set_cognito_password.ps1 -UserPoolId ap-south-1_XXXX -Email you@example.edu
param(
    [Parameter(Mandatory = $true)] [string] $UserPoolId,
    [Parameter(Mandatory = $true)] [string] $Email,
    [string] $Region = 'ap-south-1'
)

$first = Read-Host 'New TransitShield password (12+ chars, upper, lower, number)' -AsSecureString
$second = Read-Host 'Repeat the password' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $first).Password
$again = [System.Net.NetworkCredential]::new('', $second).Password

try {
    if ($plain -cne $again) { Write-Host 'Passwords do not match. Nothing was changed.' -ForegroundColor Red; exit 1 }
    if ($plain.Length -lt 12 -or $plain -cnotmatch '[A-Z]' -or $plain -cnotmatch '[a-z]' -or $plain -notmatch '[0-9]') {
        Write-Host 'Password must be at least 12 characters with an upper-case letter, a lower-case letter and a number. Nothing was changed.' -ForegroundColor Red
        exit 1
    }
    aws cognito-idp admin-set-user-password --user-pool-id $UserPoolId --username $Email --password $plain --permanent --region $Region
    if ($LASTEXITCODE -ne 0) { Write-Host 'AWS rejected the change (see the message above). Nothing was changed.' -ForegroundColor Red; exit 1 }
    $status = aws cognito-idp admin-get-user --user-pool-id $UserPoolId --username $Email --region $Region --query UserStatus --output text
    Write-Host "Done. Account status: $status. You can now sign in on the TransitShield site." -ForegroundColor Green
}
finally {
    $plain = $null; $again = $null; $first = $null; $second = $null
}
