export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === 'localhost.localdomain' || normalized.endsWith('.localhost')) {
    return true;
  }
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return ipv4[0] === 127;
  }
  const ipv6 = parseIpv6(normalized);
  if (!ipv6) {
    return false;
  }
  const ipv6Loopback = ipv6.slice(0, 7).every(group => group === 0) && ipv6[7] === 1;
  const mappedIpv4Loopback = ipv6.slice(0, 5).every(group => group === 0) && ipv6[5] === 0xffff && (ipv6[6] >> 8) === 127;
  return ipv6Loopback || mappedIpv4Loopback;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length > 4 || parts.some(part => part.length === 0)) {
    return null;
  }
  const numbers = parts.map(parseIpv4Number);
  if (numbers.some(part => part === null)) {
    return null;
  }
  const parsed = numbers as number[];
  if (parsed.slice(0, -1).some(part => part > 255)) {
    return null;
  }
  const finalLimit = 256 ** (5 - parsed.length) - 1;
  if (parsed[parsed.length - 1] > finalLimit) {
    return null;
  }
  let address = parsed[parsed.length - 1];
  for (let index = 0; index < parsed.length - 1; index++) {
    address += parsed[index] * 256 ** (3 - index);
  }
  return [
    Math.floor(address / 256 ** 3) % 256,
    Math.floor(address / 256 ** 2) % 256,
    Math.floor(address / 256) % 256,
    address % 256
  ];
}

function parseIpv4Number(value: string): number | null {
  let radix = 10;
  let digits = value;
  if (/^0x/i.test(value)) {
    radix = 16;
    digits = value.slice(2);
  } else if (value.length > 1 && value.startsWith('0')) {
    radix = 8;
    digits = value.slice(1);
  }
  let pattern = /^\d+$/;
  if (radix === 16) {
    pattern = /^[a-f0-9]+$/i;
  } else if (radix === 8) {
    pattern = /^[0-7]+$/;
  }
  if (!pattern.test(digits)) {
    return null;
  }
  const parsed = Number.parseInt(digits, radix);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseIpv6(value: string): number[] | null {
  if (!value.includes(':') || value.split('::').length > 2) {
    return null;
  }
  const [leftText, rightText = ''] = value.split('::');
  const left = parseIpv6Side(leftText);
  const right = parseIpv6Side(rightText);
  if (!left || !right) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((value.includes('::') && missing < 1) || (!value.includes('::') && missing !== 0)) {
    return null;
  }
  return [...left, ...Array(missing).fill(0), ...right];
}

function parseIpv6Side(value: string): number[] | null {
  if (!value) {
    return [];
  }
  const groups: number[] = [];
  for (const part of value.split(':')) {
    const ipv4 = part.includes('.') ? parseIpv4(part) : null;
    if (ipv4) {
      groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
    } else if (/^[a-f0-9]{1,4}$/i.test(part)) {
      groups.push(Number.parseInt(part, 16));
    } else {
      return null;
    }
  }
  return groups;
}
