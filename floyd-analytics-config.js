window.FLOYD_POSTHOG_CONFIG = {
  // Public ingestion token, not a secret or account-management credential.
  projectToken: 'phc_tDSDGSVGcqYig87kEJDBAP7vGnf2bLPAbGiL8UsvZTh4',
  apiHost: 'https://us.i.posthog.com',
  sites: {
    'floydcoapparel.com': {id: 'floyd-apparel', paths: ['^/$', '^/schools/[a-z0-9-]+/[a-z0-9-]+/$']},
    'floydspaintandbody.com': {id: 'floyd-paint-body', paths: ['^/$', '^/index\\.html$']},
  },
};
