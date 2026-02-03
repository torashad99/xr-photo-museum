// src/services/googleAuth.ts
const CLIENT_ID = 'YOUR_CLIENT_ID';
const REDIRECT_URI = 'https://localhost:8081/callback';
const SCOPES = 'https://www.googleapis.com/auth/photoslibrary.readonly';

export class GoogleAuthService {
  private accessToken: string | null = null;

  async initiateLogin(): Promise<void> {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('scope', SCOPES);
    
    window.location.href = authUrl.toString();
  }

  handleCallback(): string | null {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    this.accessToken = params.get('access_token');
    return this.accessToken;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }
}