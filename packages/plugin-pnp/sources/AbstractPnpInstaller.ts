import {Installer, LinkOptions, LinkType, MessageName, DependencyMeta, Manifest, LocatorHash, FinalizeInstallData, BuildType} from '@yarnpkg/core';
import {FetchResult, Descriptor, Locator, Package, BuildDirective}                                                            from '@yarnpkg/core';
import {miscUtils, structUtils}                                                                                               from '@yarnpkg/core';
import {FakeFS, Filename, PortablePath, ppath}                                                                                from '@yarnpkg/fslib';
import {PackageRegistry, PnpSettings}                                                                                         from '@yarnpkg/pnp';

const cachedFields = new Set([
  `bin` as const,
  `cpu` as const,
  `os` as const,
  `preferUnplugged` as const,
  `scripts` as const,
]);

const cachedScripts = new Set([
  `preinstall`,
  `install`,
  `postinstall`,
]);

const FORCED_UNPLUG_FILETYPES = new Set([
  // Windows can't execute exe files inside zip archives
  `.exe`,
  // The c/c++ compiler can't read files from zip archives
  `.h`, `.hh`, `.hpp`, `.c`, `.cc`, `.cpp`,
  // The java runtime can't read files from zip archives
  `.java`, `.jar`,
  // Node opens these through dlopen
  `.node`,
]);

type SetValue<T> = T extends Set<infer U> ? U : never;

export type PartialManifest = Pick<Manifest, SetValue<typeof cachedFields>>;
export type PackageDataRecord = {
  extractHint: boolean,
  hasBindingGyp: boolean,
  manifest: PartialManifest,
};

export type AbstractInstallerOptions = LinkOptions & {
  skipIncompatiblePackageLinking?: boolean;
};

export type AbstractInstallerCustomData = {
  store: Map<LocatorHash, PackageDataRecord>,
};

export abstract class AbstractPnpInstaller implements Installer {
  private packageRegistry: PackageRegistry = new Map();
  private blacklistedPaths: Set<PortablePath> = new Set();

  private extraneousPackageRecords: Set<LocatorHash> = new Set();
  private customData: AbstractInstallerCustomData = {store: new Map()};

  constructor(protected opts: AbstractInstallerOptions) {
    this.opts = opts;
  }

  /**
   * Allow child classes to tweaks a few settings.
   */
  abstract getChildClassSettings(): {
    installPackageBuilds: boolean;
  };

  /**
   * Called to transform the package before it's stored in the PnP map. For
   * example we use this in the PnP linker to materialize the packages within
   * their own directories when they have build scripts.
   */
  abstract transformPackage(pkg: Package, pkgDataRecord: PackageDataRecord, fetchResult: FetchResult, dependencyMeta: DependencyMeta): Promise<FakeFS<PortablePath>>;

  /**
   * Called with the full settings, ready to be used by the @yarnpkg/pnp
   * package.
   */
  abstract finalizeInstallWithPnp(pnpSettings: PnpSettings): Promise<FinalizeInstallData | void>;

  getCustomDataKey() {
    return JSON.stringify({
      name: `AbstractPnpInstaller`,
      version: 1,
    });
  }

  attachCustomData(customData: {AbstractPnpInstaller: AbstractInstallerCustomData}) {
    this.extraneousPackageRecords = new Set(customData.AbstractPnpInstaller.store.keys());
    this.customData = customData.AbstractPnpInstaller;
  }

  private checkManifestCompatibility(pkg: Package, manifest: Pick<Manifest, 'os' | 'cpu'>) {
    if (!Manifest.isManifestFieldCompatible(manifest.os, process.platform))
      return false;

    if (!Manifest.isManifestFieldCompatible(manifest.cpu, process.arch))
      return false;

    return true;
  }

  private checkAndReportManifestCompatibility(pkg: Package, manifest: Pick<Manifest, 'os' | 'cpu'>) {
    if (!Manifest.isManifestFieldCompatible(manifest.os, process.platform)) {
      this.opts.report.reportWarningOnce(MessageName.INCOMPATIBLE_OS, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} The platform ${process.platform} is incompatible with this module, ${this.opts.skipIncompatiblePackageLinking ? `linking` : `building`} skipped.`);
      return false;
    }

    if (!Manifest.isManifestFieldCompatible(manifest.cpu, process.arch)) {
      this.opts.report.reportWarningOnce(MessageName.INCOMPATIBLE_CPU, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} The CPU architecture ${process.arch} is incompatible with this module, ${this.opts.skipIncompatiblePackageLinking ? `linking` : `building`} skipped.`);
      return false;
    }

    return true;
  }

  private async fetchPackageDataRecord(fetchResult: FetchResult) {
    const bindingFilePath = ppath.join(fetchResult.prefixPath, `binding.gyp` as Filename);
    const hasBindingGyp = fetchResult.packageFs.existsSync(bindingFilePath);

    const extractHint = fetchResult.packageFs.getExtractHint({relevantExtensions:FORCED_UNPLUG_FILETYPES});

    const data: PackageDataRecord = {
      extractHint,
      hasBindingGyp,
      manifest: {} as any,
    };

    const manifest = await Manifest.tryFind(fetchResult.prefixPath, {baseFs: fetchResult.packageFs});
    const effectiveManifest = manifest ?? new Manifest();

    for (const field of cachedFields)
      data.manifest[field] = effectiveManifest[field] as any;

    for (const scriptName of data.manifest.scripts.keys())
      if (!cachedScripts.has(scriptName))
        cachedScripts.delete(scriptName);

    return data;
  }

  private async ensurePackageDataRecord(locator: Locator, fetchResult: FetchResult) {
    this.extraneousPackageRecords.delete(locator.locatorHash);

    const record = this.customData.store.get(locator.locatorHash);
    if (typeof record !== `undefined`)
      return record;

    const newRecord = await this.fetchPackageDataRecord(fetchResult);
    this.customData.store.set(locator.locatorHash, newRecord);
    return newRecord;
  }

  protected getPackageDataStore() {
    return this.customData.store;
  }

  protected getPackageDataRecord(locator: Locator) {
    const record = this.customData.store.get(locator.locatorHash);
    if (typeof record === `undefined`)
      throw new Error(`Assertion failed: Expected locator to have been registered (${structUtils.prettyLocator(this.opts.project.configuration, locator)})`);

    return record;
  }

  protected extractSuggestedBuildScripts(pkg: Package, pkgDataRecord: PackageDataRecord) {
    const buildScripts: Array<BuildDirective> = [];

    for (const scriptName of [`preinstall`, `install`, `postinstall`])
      if (pkgDataRecord.manifest.scripts.has(scriptName))
        buildScripts.push([BuildType.SCRIPT, scriptName]);

    // Detect cases where a package has a binding.gyp but no install script
    if (!pkgDataRecord.manifest.scripts.has(`install`) && pkgDataRecord.hasBindingGyp)
      buildScripts.push([BuildType.SHELLCODE, `node-gyp rebuild`]);

    const dependencyMeta = this.opts.project.getDependencyMeta(pkg, pkg.version);

    if (buildScripts.length > 0 && !this.opts.project.configuration.get(`enableScripts`) && !dependencyMeta.built) {
      this.opts.report.reportWarningOnce(MessageName.DISABLED_BUILD_SCRIPTS, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but all build scripts have been disabled.`);
      buildScripts.length = 0;
    }

    if (buildScripts.length > 0 && pkg.linkType !== LinkType.HARD && !this.opts.project.tryWorkspaceByLocator(pkg)) {
      this.opts.report.reportWarningOnce(MessageName.SOFT_LINK_BUILD, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but is referenced through a soft link. Soft links don't support build scripts, so they'll be ignored.`);
      buildScripts.length = 0;
    }

    if (buildScripts.length > 0 && dependencyMeta && dependencyMeta.built === false) {
      this.opts.report.reportInfoOnce(MessageName.BUILD_DISABLED, `${structUtils.prettyLocator(this.opts.project.configuration, pkg)} lists build scripts, but its build has been explicitly disabled through configuration.`);
      buildScripts.length = 0;
    }

    return buildScripts;
  }

  async installPackage(pkg: Package, fetchResult: FetchResult) {
    const pkgDataRecord = await this.ensurePackageDataRecord(pkg, fetchResult);

    const key1 = structUtils.requirableIdent(pkg);
    const key2 = pkg.reference;

    const isWorkspace =
      !!this.opts.project.tryWorkspaceByLocator(pkg);

    const hasVirtualInstances =
      // Only packages with peer dependencies have virtual instances
      pkg.peerDependencies.size > 0 &&
      // Virtualized instances have no further virtual instances
      !structUtils.isVirtualLocator(pkg);

    const shouldRunBuildScripts =
      // Virtual instance templates don't need to be built, since they don't truly exist
      !hasVirtualInstances &&
      // Workspaces aren't built by the linkers; they are managed by the core itself
      !isWorkspace &&
      // Only build the packages if the final installer tells us to
      this.getChildClassSettings().installPackageBuilds;

    const buildScripts = shouldRunBuildScripts
      ? this.extractSuggestedBuildScripts(pkg, pkgDataRecord)
      : [];

    const dependencyMeta = this.opts.project.getDependencyMeta(pkg, pkg.version);

    // If the package is hardlinked (ie if Yarn owns its folder), then we let
    // the concrete installer "transform" the package before we reference it
    // into the PnP map. We skip this in two cases:
    //
    // - If the package is soft-linked then it means the user explicitly
    //   requested that we use its sources, so we can't tramsform them
    //
    // - If the package has virtual instances then it's just a template and
    //   there's no point transforming it, since it won't be used directly.
    //
    const packageFs = !hasVirtualInstances && pkg.linkType !== LinkType.SOFT
      ? await this.transformPackage(pkg, pkgDataRecord, fetchResult, dependencyMeta)
      : fetchResult.packageFs;

    if (ppath.isAbsolute(fetchResult.prefixPath))
      throw new Error(`Assertion failed: Expected the prefix path (${fetchResult.prefixPath}) to be relative to the parent`);

    const packageRawLocation = ppath.resolve(packageFs.getRealPath(), fetchResult.prefixPath);

    const packageLocation = this.normalizeDirectoryPath(packageRawLocation);
    const packageDependencies = new Map<string, string | [string, string] | null>();
    const packagePeers = new Set<string>();

    // Only virtual packages should have effective peer dependencies, but the
    // workspaces are a special case because the original packages are kept in
    // the dependency tree even after being virtualized; so in their case we
    // just ignore their declared peer dependencies.
    if (structUtils.isVirtualLocator(pkg)) {
      for (const descriptor of pkg.peerDependencies.values()) {
        packageDependencies.set(structUtils.requirableIdent(descriptor), null);
        packagePeers.add(structUtils.stringifyIdent(descriptor));
      }
    }

    miscUtils.getMapWithDefault(this.packageRegistry, key1).set(key2, {
      packageLocation,
      packageDependencies,
      packagePeers,
      linkType: pkg.linkType,
      discardFromLookup: fetchResult.discardFromLookup || false,
    });

    // Workspaces can always be accessed from their own directories, even if
    // they have virtual instances, since they have their own perspective.
    if (hasVirtualInstances && !isWorkspace)
      this.blacklistedPaths.add(packageLocation);

    // Ignore the build scripts if the package isn't compatible with the current system
    const effectiveBuildDirectives = buildScripts.length > 0 && this.checkAndReportManifestCompatibility(pkg, pkgDataRecord.manifest)
      ? buildScripts
      : null;

    return {
      packageLocation: packageRawLocation,
      buildDirective: effectiveBuildDirectives,
    };
  }

  async attachInternalDependencies(locator: Locator, dependencies: Array<[Descriptor, Locator]>) {
    const packageInformation = this.getPackageInformation(locator);

    for (const [descriptor, locator] of dependencies) {
      const target = !structUtils.areIdentsEqual(descriptor, locator)
        ? [structUtils.requirableIdent(locator), locator.reference] as [string, string]
        : locator.reference;

      packageInformation.packageDependencies.set(structUtils.requirableIdent(descriptor), target);
    }
  }

  async attachExternalDependents(locator: Locator, dependentPaths: Array<PortablePath>) {
    for (const dependentPath of dependentPaths) {
      const packageInformation = this.getDiskInformation(dependentPath);

      packageInformation.packageDependencies.set(structUtils.requirableIdent(locator), locator.reference);
    }
  }

  async finalizeInstall() {
    this.trimBlacklistedPackages();

    this.packageRegistry.set(null, new Map([
      [null, this.getPackageInformation(this.opts.project.topLevelWorkspace.anchoredLocator)],
    ]));

    const pnpFallbackMode = this.opts.project.configuration.get(`pnpFallbackMode`);

    const blacklistedLocations = this.blacklistedPaths;
    const dependencyTreeRoots = this.opts.project.workspaces.map(({anchoredLocator}) => ({name: structUtils.requirableIdent(anchoredLocator), reference: anchoredLocator.reference}));
    const enableTopLevelFallback = pnpFallbackMode !== `none`;
    const fallbackExclusionList = [];
    const fallbackPool = new Map();
    const ignorePattern = miscUtils.buildIgnorePattern([`.yarn/sdks/**`, ...this.opts.project.configuration.get(`pnpIgnorePatterns`)]);
    const packageRegistry = this.packageRegistry;
    const shebang = this.opts.project.configuration.get(`pnpShebang`);

    if (pnpFallbackMode === `dependencies-only`)
      for (const pkg of this.opts.project.storedPackages.values())
        if (this.opts.project.tryWorkspaceByLocator(pkg))
          fallbackExclusionList.push({name: structUtils.requirableIdent(pkg), reference: pkg.reference});

    const result = await this.finalizeInstallWithPnp({
      blacklistedLocations,
      dependencyTreeRoots,
      enableTopLevelFallback,
      fallbackExclusionList,
      fallbackPool,
      ignorePattern,
      packageRegistry,
      shebang,
    });

    const finalResult: FinalizeInstallData = typeof result !== `undefined`
      ? result
      : {};

    if (typeof finalResult.customData === `undefined`)
      finalResult.customData = {};

    finalResult.customData.AbstractInstallerCustomData = this.customData;
    return finalResult;
  }

  private getPackageInformation(locator: Locator) {
    const key1 = structUtils.requirableIdent(locator);
    const key2 = locator.reference;

    const packageInformationStore = this.packageRegistry.get(key1);
    if (!packageInformationStore)
      throw new Error(`Assertion failed: The package information store should have been available (for ${structUtils.prettyIdent(this.opts.project.configuration, locator)})`);

    const packageInformation = packageInformationStore.get(key2);
    if (!packageInformation)
      throw new Error(`Assertion failed: The package information should have been available (for ${structUtils.prettyLocator(this.opts.project.configuration, locator)})`);

    return packageInformation;
  }

  private getDiskInformation(path: PortablePath) {
    const packageStore = miscUtils.getMapWithDefault(this.packageRegistry, `@@disk`);
    const normalizedPath = this.normalizeDirectoryPath(path);

    return miscUtils.getFactoryWithDefault(packageStore, normalizedPath, () => ({
      packageLocation: normalizedPath,
      packageDependencies: new Map(),
      packagePeers: new Set<string>(),
      linkType: LinkType.SOFT,
      discardFromLookup: false,
    }));
  }

  private trimBlacklistedPackages() {
    for (const packageStore of this.packageRegistry.values()) {
      for (const [key2, packageInformation] of packageStore) {
        if (packageInformation.packageLocation && this.blacklistedPaths.has(packageInformation.packageLocation)) {
          packageStore.delete(key2);
        }
      }
    }
  }

  private normalizeDirectoryPath(folder: PortablePath) {
    let relativeFolder = ppath.relative(this.opts.project.cwd, folder);

    if (!relativeFolder.match(/^\.{0,2}\//))
      // Don't use ppath.join here, it ignores the `.`
      relativeFolder = `./${relativeFolder}` as PortablePath;

    return relativeFolder.replace(/\/?$/, `/`)  as PortablePath;
  }
}
