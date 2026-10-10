import net from "node:net";

// IPv6 visitors are counted by their /64, which one person usually has all of.
export function addressGroup(address: string) {
  if (net.isIPv6(address)) {
    const bare = address.split("%")[0].toLowerCase();
    const groups = bare.includes("::") ? expandIPv6(bare) : bare.split(":");
    return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
  }
  return address;
}

function expandIPv6(address: string) {
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
}
