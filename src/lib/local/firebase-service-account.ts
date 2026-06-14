// PROTOTYPE ONLY — hardcoded Firebase service account (project quickin-4baea),
// per explicit request so FCM push works without relying on the Vercel env.
// The FIREBASE_SERVICE_ACCOUNT env var, when set, OVERRIDES this (see push.ts).
// In a real production app this belongs in a secret manager, never in the repo.
export const FIREBASE_SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'quickin-4baea',
  private_key_id: '3f55ffde8b48c58da71031df9654a15d4b048f16',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDEktkUj5s/Cf8N\ncyuSNtSr5ozQl1pTn5ERhmSM8yuKrj00NPVRUlj7y6NjNuYU6ZBpUrvCbawlEYsQ\n57QMo8hjFiS2X75/x139FRa5qjqqVdWEffxOsN1lGYNGvGYNGlUoQewCUfLxell7\nLoXbVmwg9ZPxnay9Ze9sjz0p5+3WGMjjUXLuXNOnbxLR01+s9MlpcN4nlwvLciQ7\n1Gx1wU8vuQNCjn7D2oSDilCCwrxhykZNvh8fa/hDehWAb3h5rSelF1sMzNtr017g\n69GaThcGLbvlLKXwArGXg1HyMw6fPKJ0tmllVdfn5FAgGQ9mb/SDSiZVkrP6xtYP\nu3sn5kUHAgMBAAECggEAB1ZMgvofOyRLivwkVrH0OzGrn4eJXWYEe1PPAfx7lhK4\ngcUuQ5RKx6SLWy3WkFZCx85I6CdsIvq7fEHhvw0H8ubbL5wgQf22Mjbsy7j2X/A8\nkX7wVsbpj0H7W+hhThY7B88kw4C9NtUwbNVziph4XbySLT+2OGA10RFW9kRMD3nO\n6rG2WFjxSUH1ukOr+vjrmpLOTkwqX25NWpRrCjtAIPYpKdS1mtaC7QbAlapD000q\n7BItC3/KIn0nABJYCabP6it/c+0XQXNWYqD0npe/ROUL6yHowSg7Rips7YRZw1NB\nm1Vj9jvDijCMDwhnvC1qi3vVrK2pOKP3B1UzjO5l3QKBgQDrzGKXLp8/7J9ZvHZL\nWevt87KGua+1r6NV2/mQ1UqijCxG9V7WZ7rHv8yBe2VCmWko/7Ls58e/Op4QFZhe\new9mRUIKuFFxJ9UvhjlpLTBke04P4+xLhZhrhAPrx/G1weZnrceiqwIBqcnO4+Wf\n8GwtQi+XIbl2/QZ5T0Hgp3andQKBgQDVaivifi4MVuTUZFpHzH7UJvvWjhrlMd8V\nucI7/z/QzzHiGYkXQLXD9t0NuZIrdcYHh4Xs2T5u5uvyc5zQxcCz5LM4AYoigPqO\nhdSw297v7KOwqSI5jCrX6+9nSZHiNDb2drvHcovimLlyk0bErNrV5hpH/AQEZPj/\nP2VLphlnCwKBgQDqhHul+1Odw1x1ZpCMvuF85zyu7C1K2WXs9fyPxOMXKay74jyx\np7dIBYWDXlPG2keR5EZzgs7SbZ1ZR/EkPuaBA+78NHejwEcynh+pcK1Jsq1f9oNE\nVZnTjRhNP64x5Kigg2Ejc0tqlhDF+TmfSgJ9PO+SM5N/OYZfzqkpo8TKJQKBgHdr\nMaNLd/jvppwyi1Ih29Za+hDU87fMcEh36XgpHEx7pC4gm9WnIA7H1GoZrPEktesA\nqrAd4BGupdjFWLp57Zq8Hoz4T5N/GLUnrhxI7DbU88Om4L/S7yZjn1Lsl/U7woWn\nauvv7NafHyY9wxvKnamTWKFvI9BRsAMkNkpeZ1iBAoGBAJi49Z4dmojrZ3ywb6Du\n8E6Vtu9UQb7NVj723cpcAS9waGi7QA26a57Mhv85D/bOJroDqmuaCF+oc0GQdpfY\nT2SWj4vIZXHyMTsJISMYcxy9HPxoQ/W8myniDM/DD2w1eGIxSHoOYa2m93ovIkZP\nLVOWsYwrgChpJDHY54HWig8G\n-----END PRIVATE KEY-----\n',
  client_email: 'firebase-adminsdk-fbsvc@quickin-4baea.iam.gserviceaccount.com',
  client_id: '104786364421836838746',
  token_uri: 'https://oauth2.googleapis.com/token',
}
