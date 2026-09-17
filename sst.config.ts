/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'hlab-b',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: {
          region: 'eu-central-1',
          // the cloud runner has ambient role credentials; the laptop keeps its named profile for read-only commands
          ...(process.env.CODEBUILD_BUILD_ID ? {} : { profile: 'FuturatorClaude' }),
          defaultTags: {
            tags: {
              App: 'hlab-b',
              Owner: 'ricardo',
              Capability: 'pacman',
              CostCenter: 'mycelium-harness',
              Service: 'hlab-b',
              Environment: input?.stage ?? 'dev',
              DataClassification: 'internal',
              ManagedBy: 'sst',
            },
          },
        },
      },
    };
  },
  async run() {
    const site = new sst.aws.StaticSite('Web', {
      build: {
        command: 'npm run build',
        output: 'dist',
      },
    });
    return { url: site.url };
  },
});
