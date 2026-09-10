import { writeFileSync } from 'node:fs';
import { validateImage } from './deploy-release.mts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const release = {
  repository: requiredEnvironment('GITHUB_REPOSITORY'),
  sha: requiredEnvironment('GITHUB_SHA'),
  run_id: requiredEnvironment('GITHUB_RUN_ID'),
  image_ref: requiredEnvironment('IMAGE_REF'),
};
validateImage(release.image_ref, release.sha, release.repository);
writeFileSync('release/release.json', JSON.stringify(release));
