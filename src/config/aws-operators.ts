/** Named company lanes allowed to use the gateway's read-only AWS MCP bridge. */
export const AWS_OPERATOR_LANES = ['cto', 'developer', 'cfo', 'coo', 'cro'] as const;

export type AwsOperatorLane = (typeof AWS_OPERATOR_LANES)[number];

export function isAwsOperatorLane(lane: string): lane is AwsOperatorLane {
  return (AWS_OPERATOR_LANES as readonly string[]).includes(lane);
}
