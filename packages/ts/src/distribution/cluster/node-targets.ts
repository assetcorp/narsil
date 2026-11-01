export function targetsOfRegisteredNode(nodeId: string, address: string): string[] {
  return address.length === 0 || address === nodeId ? [nodeId] : [address, nodeId]
}
