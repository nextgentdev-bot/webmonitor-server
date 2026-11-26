import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import tls from 'node:tls';

const rdapTimeoutMs = 8000;
const dnsTimeoutMs = 5000;
const tlsTimeoutMs = 6000;

const noRecordErrors = new Set(['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ECONNREFUSED']);
const commonCountryCodeSecondLevels = new Set([
  'ac', 'asn', 'biz', 'co', 'com', 'edu', 'firm', 'gen', 'go', 'gov',
  'id', 'mil', 'ne', 'net', 'or', 'org', 'plc', 're'
]);

function isPublicIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second, third] = parts;
  return !(
    first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 88 && third === 99)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
  );
}

export function isPublicIp(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const value = address.toLowerCase();
  if (value.startsWith('::ffff:')) return isPublicIpv4(value.slice(7));
  return !(
    value === '::' || value === '::1'
    || value.startsWith('fc') || value.startsWith('fd')
    || /^fe[89ab]/.test(value) || value.startsWith('ff')
    || value.startsWith('2001:db8:')
  );
}

function domainCandidates(hostname) {
  if (isIP(hostname) || !hostname.includes('.')) return [];
  const labels = hostname.split('.').filter(Boolean);
  const candidates = [];
  const countryCodeSuffix = labels.at(-1)?.length === 2 && commonCountryCodeSecondLevels.has(labels.at(-2));
  const minimumLabels = countryCodeSuffix ? 3 : 2;
  while (labels.length >= minimumLabels) {
    candidates.push(labels.join('.'));
    labels.shift();
  }
  return candidates;
}

async function fetchRdap(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), rdapTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/rdap+json, application/json' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new Error(`RDAP lookup returned HTTP ${response.status}.`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupDomainRdap(hostname) {
  for (const candidate of domainCandidates(hostname)) {
    const data = await fetchRdap(`https://rdap.org/domain/${encodeURIComponent(candidate)}`);
    if (data) return { domain: candidate, data };
  }
  return null;
}

function eventDate(data, action) {
  const event = data?.events?.find((item) => String(item.eventAction || '').toLowerCase() === action);
  return event?.eventDate && Number.isFinite(Date.parse(event.eventDate)) ? event.eventDate : null;
}

function entityName(entity) {
  const properties = entity?.vcardArray?.[1];
  if (!Array.isArray(properties)) return entity?.handle || null;
  const property = properties.find(([name]) => name === 'fn' || name === 'org');
  const value = property?.[3];
  return (Array.isArray(value) ? value.join(' ') : value) || entity?.handle || null;
}

function registrarName(data) {
  const registrar = data?.entities?.find((entity) => entity.roles?.includes('registrar'));
  return registrar ? entityName(registrar) : null;
}

function getDaysRemaining(date, now = Date.now()) {
  return date ? Math.ceil((Date.parse(date) - now) / 86400000) : null;
}

function resolveDns(method, hostname) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DNS lookup timed out.')), dnsTimeoutMs);
    method(hostname).then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

async function resolveRecords(hostname, warnings) {
  const [a, aaaa, ns, mx, txt] = await Promise.all(['resolve4', 'resolve6', 'resolveNs', 'resolveMx', 'resolveTxt'].map(async (method) => {
    try {
      return await resolveDns(dns[method].bind(dns), hostname);
    } catch (error) {
      if (!noRecordErrors.has(error.code)) warnings.push(`${method.replace('resolve', '').toUpperCase()} lookup: ${error.message}`);
      return [];
    }
  }));
  return {
    ipv4: a,
    ipv6: aaaa,
    nameservers: ns,
    mailExchangers: mx.map(({ exchange, priority }) => ({ exchange, priority })).sort((first, second) => first.priority - second.priority),
    spf: txt.flat().find((record) => record.toLowerCase().startsWith('v=spf1')) || null
  };
}

async function lookupIpRdap(address) {
  if (!isPublicIp(address)) return null;
  return fetchRdap(`https://rdap.org/ip/${encodeURIComponent(address)}`);
}

function networkDetails(data) {
  if (!data) return null;
  const organization = data.entities?.map(entityName).find(Boolean);
  return {
    provider: data.name || organization || null,
    country: data.country || null,
    network: data.handle || null
  };
}

function getCertificate(hostname, address) {
  if (!address || !isPublicIp(address)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: address,
      port: 443,
      servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: false
    });
    const timeout = setTimeout(() => socket.destroy(new Error('TLS lookup timed out.')), tlsTimeoutMs);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const result = certificate?.valid_to ? {
        issuer: certificate.issuer?.O || certificate.issuer?.CN || null,
        validFrom: certificate.valid_from || null,
        validTo: certificate.valid_to,
        daysRemaining: getDaysRemaining(new Date(certificate.valid_to).toISOString()),
        authorized: socket.authorized
      } : null;
      clearTimeout(timeout);
      socket.end();
      resolve(result);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function inspectDomainHosting(url) {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  const warnings = [];
  const ipVersion = isIP(hostname);
  const records = ipVersion
    ? { ipv4: ipVersion === 4 ? [hostname] : [], ipv6: ipVersion === 6 ? [hostname] : [], nameservers: [], mailExchangers: [], spf: null }
    : await resolveRecords(hostname, warnings);
  const addresses = [...records.ipv4, ...records.ipv6];
  const publicAddress = addresses.find(isPublicIp) || null;
  const domainLookup = await lookupDomainRdap(hostname).catch((error) => {
    warnings.push(`Domain registration lookup: ${error.message}`);
    return null;
  });
  const ipLookup = publicAddress ? await lookupIpRdap(publicAddress).catch((error) => {
    warnings.push(`Hosting network lookup: ${error.message}`);
    return null;
  }) : null;
  const certificate = await getCertificate(hostname, publicAddress).catch((error) => {
    warnings.push(`SSL certificate lookup: ${error.message}`);
    return null;
  });
  const domainData = domainLookup?.data;
  const expiresAt = eventDate(domainData, 'expiration');
  const registeredAt = eventDate(domainData, 'registration');
  const nameservers = (domainData?.nameservers || []).map((server) => server.ldhName).filter(Boolean);
  if (!domainLookup) warnings.push('Public domain registration data was not available.');
  else if (!expiresAt) warnings.push('The registry did not publish an expiry date.');
  if (domainLookup && !registrarName(domainData)) warnings.push('The registrar was not listed in public registration data.');
  if (!publicAddress) warnings.push('No public IP address was found for this hostname.');
  if (!ipLookup) warnings.push('Public network/hosting details were not available.');
  if (!certificate) warnings.push('An SSL certificate could not be read from this host.');

  return {
    hostname,
    domain: domainLookup?.domain || hostname,
    registrar: registrarName(domainData),
    registeredAt,
    expiresAt,
    daysUntilExpiry: getDaysRemaining(expiresAt),
    nameservers: nameservers.length ? nameservers : records.nameservers,
    dns: records,
    hosting: networkDetails(ipLookup),
    ssl: certificate,
    warnings,
    checkedAt: new Date().toISOString()
  };
}

export const domainInfoInternals = { domainCandidates, eventDate, getDaysRemaining, registrarName };
