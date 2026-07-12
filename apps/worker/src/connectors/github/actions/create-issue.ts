import { ConnectorAdapter, AdapterRequest, AdapterResult } from '../../registry';
import { Credentials } from '../../../services/token-refresh.service';

interface GitHubResponse {
  id?: number;
  number?: number;
  html_url?: string;
  message?: string;
}

export const githubCreateIssueAdapter: ConnectorAdapter = {
  connectorId: 'github',
  supportsIdempotencyKey: false,

  buildRequest(
    mappedPayload: Record<string, unknown>,
    credentials: Credentials,
    _idempotencyKey: string,
  ): AdapterRequest {
    if (credentials.type !== 'api_key' || !credentials.apiKey) {
      throw new Error('GitHub requires a Personal Access Token (API Key)');
    }

    const owner = mappedPayload['owner'] as string;
    const repo = mappedPayload['repo'] as string;
    
    if (!owner || !repo) {
      throw new Error('Owner and Repo are required for GitHub Create Issue');
    }

    return {
      url: `https://api.github.com/repos/${owner}/${repo}/issues`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Zapier-Clone-Worker',
      },
      body: {
        title: mappedPayload['title'] as string,
        body: mappedPayload['body'] as string,
      },
    };
  },

  parseResponse(rawResponse: unknown): AdapterResult {
    const data = rawResponse as GitHubResponse;

    if (data.html_url && data.number) {
      return {
        status: 'completed',
        output: {
          issue_number: data.number,
          issue_url: data.html_url,
        },
      };
    }

    return {
      status: 'failed',
      errorCode: 'GITHUB_API_ERROR',
      errorMessage: data.message ?? 'Unknown GitHub error',
    };
  },
};
