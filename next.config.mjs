/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This is a client deliverable, not an agent workspace - don't generate
  // AGENTS.md / CLAUDE.md into the project root.
  agentRules: false,
};
export default nextConfig;
