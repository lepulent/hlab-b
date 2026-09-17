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
          profile: 'FuturatorClaude',
          defaultTags: {
            tags: {
              Project: 'hlab-b',
              ManagedBy: 'sst',
              Stage: input?.stage ?? 'dev',
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
