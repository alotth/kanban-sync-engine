import { spawnSync } from 'child_process';
import { GitHubIssue, ProjectItemStatus, SyncConfig } from './types';

function runGh(args: string[]): string {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`gh command failed: gh ${args.join(' ')}\n${stderr}`);
  }
  return (result.stdout || '').trim();
}

function ghApiJson<T>(args: string[]): T {
  const out = runGh(['api', ...args]);
  if (!out) throw new Error('Empty response from gh api');
  return JSON.parse(out) as T;
}

export function getIssues(config: SyncConfig): GitHubIssue[] {
  return ghApiJson<GitHubIssue[]>([
    `repos/${config.owner}/${config.repo}/issues?state=all&per_page=100`
  ]);
}

export function createIssue(config: SyncConfig, input: {
  title: string;
  body?: string;
  labels?: string[];
  milestone?: string;
}): GitHubIssue {
  const args = [`repos/${config.owner}/${config.repo}/issues`, '-X', 'POST', '-f', `title=${input.title}`];
  if (input.body) args.push('-f', `body=${input.body}`);
  if (input.labels && input.labels.length > 0) {
    for (const label of input.labels) {
      args.push('-f', `labels[]=${label}`);
    }
  }
  if (input.milestone) args.push('-f', `milestone=${input.milestone}`);
  return ghApiJson<GitHubIssue>(args);
}

export function updateIssue(config: SyncConfig, issueNumber: number, input: {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
}): GitHubIssue {
  const args = [`repos/${config.owner}/${config.repo}/issues/${issueNumber}`, '-X', 'PATCH'];
  if (input.title !== undefined) args.push('-f', `title=${input.title}`);
  if (input.body !== undefined) args.push('-f', `body=${input.body}`);
  if (input.state !== undefined) args.push('-f', `state=${input.state}`);
  if (input.labels !== undefined) {
    for (const label of input.labels) {
      args.push('-f', `labels[]=${label}`);
    }
    if (input.labels.length === 0) {
      args.push('-f', 'labels[]');
    }
  }
  return ghApiJson<GitHubIssue>(args);
}

export function getProjectStatuses(config: SyncConfig): ProjectItemStatus[] {
  if (!config.projectId || !config.statusFieldId) return [];

  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              content {
                ... on Issue {
                  number
                  repository {
                    name
                    owner { login }
                  }
                }
              }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2SingleSelectField {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = ghApiJson<any>(['graphql', '-f', `query=${query}`, '-f', `projectId=${config.projectId}`]);
  const nodes = response?.data?.node?.items?.nodes || [];
  const out: ProjectItemStatus[] = [];

  for (const node of nodes) {
    const issue = node?.content;
    if (!issue || issue.repository?.owner?.login !== config.owner || issue.repository?.name !== config.repo) continue;
    const statusNode = (node.fieldValues?.nodes || []).find((fv: any) => fv?.field?.id === config.statusFieldId && typeof fv?.name === 'string');
    if (!statusNode || !statusNode.name) continue;
    out.push({ issueNumber: issue.number, itemId: node.id, statusName: statusNode.name });
  }
  return out;
}

export function getStatusOptionIds(config: SyncConfig): Record<string, string> {
  if (!config.projectId || !config.statusFieldId) return {};
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  `;
  const response = ghApiJson<any>(['graphql', '-f', `query=${query}`, '-f', `projectId=${config.projectId}`]);
  const fields = response?.data?.node?.fields?.nodes || [];
  const statusField = fields.find((f: any) => f?.id === config.statusFieldId);
  const map: Record<string, string> = {};
  for (const opt of statusField?.options || []) {
    map[opt.name] = opt.id;
  }
  return map;
}

export function addIssueToProject(config: SyncConfig, issueNodeId: string): string {
  if (!config.projectId) throw new Error('projectId is required to add issue to project');
  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item {
          id
        }
      }
    }
  `;
  const response = ghApiJson<any>([
    'graphql',
    '-f', `query=${mutation}`,
    '-f', `projectId=${config.projectId}`,
    '-f', `contentId=${issueNodeId}`
  ]);
  return response?.data?.addProjectV2ItemById?.item?.id;
}

export function setProjectItemStatus(config: SyncConfig, itemId: string, optionId: string): void {
  if (!config.projectId || !config.statusFieldId) return;
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;
  ghApiJson<any>([
    'graphql',
    '-f', `query=${mutation}`,
    '-f', `projectId=${config.projectId}`,
    '-f', `itemId=${itemId}`,
    '-f', `fieldId=${config.statusFieldId}`,
    '-f', `optionId=${optionId}`
  ]);
}
