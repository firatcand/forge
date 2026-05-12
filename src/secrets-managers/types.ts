export type SecretsManagerType = 'env_file';
// NOTE: schemas/settings.ts allows 4 more values in the discriminated union
// (1password, aws_secrets, doppler, infisical). This narrowed type is what
// has a working adapter today. core/secrets.ts dispatches env_file here and
// throws SecretsError(MISCONFIGURED) for the unbuilt members.

export interface GetOpts {
  optional?: boolean;
}
