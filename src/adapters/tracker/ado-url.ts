/**
 * Azure DevOps URL construction, shared by the tracker and the pipelines adapter.
 *
 * Every ADO REST call is `{collection}/{project}/_apis/...`. What differs is
 * where the collection ends - and, critically, whether the organisation is a
 * path segment or part of the hostname:
 *
 *   cloud    https://dev.azure.com/{organization}      org is a path segment
 *   legacy   https://{organization}.visualstudio.com   org is the subdomain
 *   on-prem  https://tfs.company.local/tfs/{collection}
 *
 * So `baseUrl` is the single source of truth and `organization` is optional.
 * It is appended only when it is not ALREADY present - either as the last path
 * segment or as the hostname's first label. Appending it to a legacy URL
 * produces `/{org}/{project}` and ADO answers TF200016 "project does not
 * exist: {org}", which reads like a permissions problem and is not one.
 */

const DEFAULT_HOST = 'https://dev.azure.com';

const strip = (s: string): string => s.trim().replace(/\/+$/, '');
const eq = (a: string | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase();

/** Is the organisation already part of this base URL, in either position? */
export function organizationIsImplicit(base: string, organization: string): boolean {
  let hostFirstLabel: string | undefined;
  try {
    hostFirstLabel = new URL(base).hostname.split('.')[0];
  } catch {
    hostFirstLabel = undefined;
  }
  if (eq(hostFirstLabel, organization)) return true;
  return eq(base.split('/').pop(), organization);
}

export function collectionUrl(baseUrl: string | undefined, organization: string | undefined): string {
  const org = organization?.trim();
  // `organization` may itself be a full collection URL - that is how people
  // actually paste it. When it is, it wins outright and baseUrl is ignored.
  if (org !== undefined && /^https?:\/\//i.test(org)) return strip(org);
  const base = strip(baseUrl ?? DEFAULT_HOST);
  if (org === undefined || org === '') return base;
  return organizationIsImplicit(base, org) ? base : `${base}/${encodeURIComponent(org)}`;
}

export function projectUrl(
  baseUrl: string | undefined,
  organization: string | undefined,
  project: string | undefined,
): string {
  const collection = collectionUrl(baseUrl, organization);
  const name = (project ?? '').trim();
  // Project names contain spaces far more often than anyone expects.
  return name === '' ? collection : `${collection}/${encodeURIComponent(name)}`;
}

/**
 * Release Management sits on a separate host, and the rule differs per domain:
 *
 *   https://dev.azure.com/org        -> https://vsrm.dev.azure.com/org
 *   https://org.visualstudio.com     -> https://org.vsrm.visualstudio.com
 *   https://tfs.local/tfs/Collection -> unchanged (same host on-prem)
 *
 * Getting this wrong produces a 401 rather than a 404, which sends you off
 * regenerating a perfectly good PAT. Hence the explicit cases.
 */
export function releaseCollectionUrl(baseUrl: string | undefined, organization: string | undefined): string {
  const collection = collectionUrl(baseUrl, organization);
  if (/^https:\/\/dev\.azure\.com/i.test(collection)) {
    return collection.replace(/^https:\/\/dev\.azure\.com/i, 'https://vsrm.dev.azure.com');
  }
  const legacy = /^https:\/\/([^./]+)\.visualstudio\.com/i.exec(collection);
  if (legacy !== null) {
    return collection.replace(
      /^https:\/\/([^./]+)\.visualstudio\.com/i,
      `https://${legacy[1] as string}.vsrm.visualstudio.com`,
    );
  }
  return collection;
}

export function releaseProjectUrl(
  baseUrl: string | undefined,
  organization: string | undefined,
  project: string | undefined,
): string {
  const collection = releaseCollectionUrl(baseUrl, organization);
  const name = (project ?? '').trim();
  return name === '' ? collection : `${collection}/${encodeURIComponent(name)}`;
}