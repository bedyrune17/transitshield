// Public, NON-SECRET frontend configuration. Written by scripts/deploy.py
// after a successful AWS deployment. These identifiers are safe to publish:
// they do not grant access on their own - every API call must still be
// signed with short-lived identity-pool credentials of a signed-in user AND
// carry a Cognito access token that the API verifies server-side.
// Leave values empty to run in local demo mode only.
export default {
  region: "ap-south-1",
  userPoolId: "ap-south-1_Nj30ZtDNf",
  userPoolClientId: "em3dk6arajl097e7kil8eaq16",
  identityPoolId: "ap-south-1:f62d0eae-9209-48fc-95c3-164b5c735b57",
  cognitoDomain: "transitshield-fdcb2ac050.auth.ap-south-1.amazoncognito.com",
  apiUrl: "https://2qfarorkot33mefu27f3ycuc4q0jhrag.lambda-url.ap-south-1.on.aws/",
  apiAuthType: "AWS_IAM",
  stackName: "transitshield",
  deployedAt: "2026-10-16T18:14:28Z",
};
