import { access, readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));

const failures = [];
if (packageJson.version !== manifest.version) {
  failures.push(`package.json version ${packageJson.version} does not match manifest ${manifest.version}`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  failures.push(`versions.json does not map ${manifest.version} to ${manifest.minAppVersion}`);
}
const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${manifest.version}`) {
  failures.push(`release tag ${releaseTag} does not match v${manifest.version}`);
}
for (const asset of ["main.js", "manifest.json", "styles.css"]) {
  try {
    await access(asset);
  } catch {
    failures.push(`missing release asset: ${asset}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Release verification failed:\n- ${failures.join("\n- ")}`);
}
console.log(`Release metadata and assets verified for v${manifest.version}.`);
