// Keep the existing x64 download URLs while distinguishing native ARM64
// installers and archives. Signing jobs pass the same patterns as explicit
// builder options because that isolated phase intentionally disables hooks.
export function windowsArtifactNamePatterns(arch) {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`unsupported Windows artifact architecture: ${arch}`)
  }
  const suffix = arch === 'arm64' ? '-arm64' : ''
  return {
    nsis: `\${productName}-Setup-\${version}${suffix}.\${ext}`,
    zip: `\${productName}-\${version}-win${suffix}.\${ext}`,
  }
}

export function configureWindowsArtifactNames(targets, arch) {
  const patterns = windowsArtifactNamePatterns(arch)
  for (const target of targets) {
    const pattern = patterns[target.name]
    if (!pattern) continue
    // electron-builder creates targets before beforePack, and NSIS copies its
    // options in the constructor. Update the target's resolved options rather
    // than only mutating packager.config, which would leave NSIS unchanged.
    target.options = { ...target.options, artifactName: pattern }
    if (target.name === 'nsis') target.options.buildUniversalInstaller = false
  }
}
