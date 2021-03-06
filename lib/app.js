import { OpenOcdFlasher } from './openocd_flasher';
import { DfuFlasher } from './dfu_flasher';
import { ModuleCache } from './module_cache';
import { ParticleApi } from './particle_api';
import { platformForName } from './platform';
import { isDeviceId } from './util';

import tmp from 'tmp';
import mkdirp from 'mkdirp';
import semver from 'semver';

import * as os from 'os';
import * as path from 'path';

tmp.setGracefulCleanup();

export class App {
	constructor({ name, log }) {
		this._log = log;
		this._name = name;
		this._flasher = null;
		this._cache = null;
		this._api = null;
		this._homeDir = null;
		this._tempDir = null;
	}

	async init(args) {
		// Parse arguments
		const version = this._parseVersionArg(args);
		const devArgs = this._parseDeviceArgs(args);
		// Create home and temp directories
		this._homeDir = path.join(os.homedir(), '.particle', this._name);
		mkdirp.sync(this._homeDir);
		this._tempDir = tmp.dirSync({
			prefix: this._name + '-',
			unsafeCleanup: true // Remove the directory even if it's not empty
		}).name;
		// Initialize module cache
		this._log.info('Initializing module cache');
		this._cache = new ModuleCache({
			cacheDir: path.join(this._homeDir, 'binaries'),
			tempDir: this._tempDir,
			log: this._log
		});
		await this._cache.init();
		await this._cache.getReleaseModules(version, { noCache: !args.cache });
/*
		// Initialize flash interface
		this._log.info('Initializing flash interface');
		if (args.openocd) {
			this._flasher = new OpenOcdFlasher({ log: this._log });
		} else {
			this._flasher = new DfuFlasher({ log: this._log });
		}
		await this._flasher.init();
		// Get target devices
		this._log.info('Enumerating local devices');
		let devs = await this._listLocalDevices();
		devs = await this._getTargetDevices(devs, devArgs);
		await this._releaseUnusedDevices(devs.unused);
		devs = devs.target;
*/
	}

	async shutdown() {
		try {
			if (this._api) {
				await this._api.shutdown();
				this._api = null;
			}
			if (this._cache) {
				await this._cache.shutdown();
				this._cache = null;
			}
			if (this._flasher) {
				await this._flasher.shutdown();
				this._flasher = null;
			}
		} catch (err) {
			this._log.warn(err.message);
		}
	}

	async _getTargetDevices(localDevs, devArgs) {
		const unknownPlatformDevIds = new Set(); // IDs of devices with unknown platform
		const devMap = new Map(); // Local devices by ID
		for (let dev of localDevs) {
			devMap.set(dev.id, dev);
			if (!dev.platformId) {
				unknownPlatformDevIds.add(dev.id);
			}
		}
		const argDevIds = new Set(); // Device IDs passed via command line
		const argDevNames = new Set(); // Device names passed via command line
		for (let arg of devArgs) {
			if (arg.id) {
				const dev = devMap.get(arg.id);
				if (!dev) {
					throw new Error(`Device not found: ${arg.id}`);
				}
				if (!dev.platformId && arg.platformId) {
					dev.platformId = arg.platformId; // Platform hint
					unknownPlatformDevIds.delete(arg.id);
				}
				argDevIds.add(arg.id);
			} else {
				argDevNames.add(arg.name);
			}
		}
		if (argDevNames.size || unknownPlatformDevIds.size) {
			// Get missing info from the cloud
			this._log.info("Getting device info from the cloud");
			const api = await this._particleApi();
			const userDevs = await api.getDevices();
			for (let userDev of userDevs) {
				if (argDevNames.delete(userDev.name)) {
					if (!devMap.has(userDev.id)) {
						throw new Error(`Device not found: ${userDev.name}`);
					}
					argDevIds.add(userDev.id);
				}
				if (unknownPlatformDevIds.delete(userDev.id)) {
					const dev = devMap.get(userDev.id);
					dev.platformId = userDev.platformId;
				}
			}
			if (argDevNames.size) {
				const name = argDevNames.values().next().value;
				throw new Error(`Unknown device: ${name}`);
			}
		}
		let target = Array.from(devMap.values());
		let unused = [];
		if (argDevIds.size) {
			unused = target.filter(dev => !argDevIds.has(dev.id));
			target = target.filter(dev => argDevIds.has(dev.id));
			for (let dev of unused) {
				unknownPlatformDevIds.delete(dev.id);
			}
		}
		if (unknownPlatformDevIds.size) {
			const id = unknownPlatformDevIds.values().next().value;
			throw new Error(`Unknown device: ${id}`);
		}
		return { target, unused };
	}

	async _releaseUnusedDevices(devs) {
		const funcs = devs.map(dev => async () => {
			await this._flasher.releaseDevice(dev.id);
		});
		await Promise.all(funcs.map(fn => fn()));
	}

	async _listLocalDevices() {
		let devs = await this._flasher.listDevices();
		if (!devs.length) {
			throw new Error('No devices found');
		}
		this._log.verbose('Found devices:');
		for (let i = 0; i < devs.length; ++i) {
			this._log.verbose(`${i + 1}. ${devs[i].id}`);
		}
		return devs;
	}

	_parseDeviceArgs(args) {
		let devArgs = args.device;
		if (!devArgs) {
			if (!args['all-devices']) {
				throw new Error('Target device is not specified');
			}
			return [];
		}
		if (args['all-devices']) {
			return [];
		}
		if (!Array.isArray(devArgs)) {
			devArgs = [devArgs];
		}
		const devs = [];
		for (let arg of devArgs) {
			const [devIdOrName, platformName] = arg.split(':');
			if (!devIdOrName) {
				throw new RangeError('Missing device ID or name');
			}
			const dev = {};
			if (isDeviceId(devIdOrName)) {
				dev.id = devIdOrName;
			} else {
				dev.name = devIdOrName;
			}
			if (platformName) {
				dev.platformId = platformForName(platformName); // Platform hint
			}
			devs.push(dev);
		}
		return devs;
	}

	_parseVersionArg(args) {
		let ver = args._[0];
		if (!ver) {
			throw new Error('Device OS version is not specified');
		}
		if (ver.startsWith('v')) {
			ver = ver.slice(1);
		}
		if (!semver.valid(ver)) {
			throw new RangeError(`Invalid Device OS version: ${args._[0]}`);
		}
		return ver;
	}

	async _particleApi() {
		if (!this._api) {
			this._api = new ParticleApi({ log: this._log });
			await this._api.init();
		}
		return this._api;
	}
}
