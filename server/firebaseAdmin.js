import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

// Exported for tests. Error messages name the variable, never its contents,
// so a malformed key can't end up in logs.
export function parseServiceAccount(serialized, env = process.env) {
  if (!serialized) throw new Error('Firebase server credentials are not configured.');

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be a JSON object.');
  }
  if (parsed.type !== undefined && parsed.type !== 'service_account') {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be a service-account key.');
  }
  const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = parsed;
  if (![projectId, clientEmail, privateKey].every((value) => typeof value === 'string' && value)) {
    throw new Error('Firebase service account JSON is missing required fields.');
  }

  // ID tokens are only valid for the project the browser signs in to. A
  // mismatch would otherwise surface as every user being told their sign-in
  // expired.
  const clientProjectId = env.VITE_FIREBASE_PROJECT_ID;
  if (clientProjectId && clientProjectId !== projectId) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON belongs to a different Firebase project than VITE_FIREBASE_PROJECT_ID.');
  }

  return {
    projectId,
    clientEmail,
    privateKey: privateKey.replace(/\\n/g, '\n'),
  };
}

function getAdminApp() {
  const existing = getApps()[0];
  if (existing) return existing;
  const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  return initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.projectId });
}

export function getAdminServices() {
  const app = getAdminApp();
  return {
    auth: getAuth(app),
    db: getFirestore(app),
    FieldValue,
  };
}
