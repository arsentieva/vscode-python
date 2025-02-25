// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// eslint-disable-next-line max-classes-per-file
import { injectable, unmanaged } from 'inversify';
import * as md5 from 'md5';
import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import { IWorkspaceService } from '../../../../common/application/types';
import '../../../../common/extensions';
import { traceDecorators, traceVerbose } from '../../../../common/logger';
import { IDisposableRegistry, IPersistentState, IPersistentStateFactory } from '../../../../common/types';
import { createDeferred, Deferred } from '../../../../common/utils/async';
import { StopWatch } from '../../../../common/utils/stopWatch';
import {
    GetInterpreterOptions,
    IInterpreterLocatorService,
    IInterpreterWatcher,
} from '../../../../interpreter/contracts';
import { IServiceContainer } from '../../../../ioc/types';
import { sendTelemetryEvent } from '../../../../telemetry';
import { EventName } from '../../../../telemetry/constants';
import { PythonEnvironment } from '../../../info';

/**
 * This class exists so that the interpreter fetching can be cached in between tests. Normally
 * this cache resides in memory for the duration of the CacheableLocatorService's lifetime, but in the case
 * of our functional tests, we want the cached data to exist outside of each test (where each test will destroy the CacheableLocatorService)
 * This gives each test a 20 second speedup.
 */
export class CacheableLocatorPromiseCache {
    private static useStatic = false;

    private static staticMap = new Map<string, Deferred<PythonEnvironment[]>>();

    private normalMap = new Map<string, Deferred<PythonEnvironment[]>>();

    public static forceUseStatic(): void {
        CacheableLocatorPromiseCache.useStatic = true;
    }

    public static forceUseNormal(): void {
        CacheableLocatorPromiseCache.useStatic = false;
    }

    public get(key: string): Deferred<PythonEnvironment[]> | undefined {
        if (CacheableLocatorPromiseCache.useStatic) {
            return CacheableLocatorPromiseCache.staticMap.get(key);
        }
        return this.normalMap.get(key);
    }

    public set(key: string, value: Deferred<PythonEnvironment[]>): void {
        if (CacheableLocatorPromiseCache.useStatic) {
            CacheableLocatorPromiseCache.staticMap.set(key, value);
        } else {
            this.normalMap.set(key, value);
        }
    }

    public delete(key: string): void {
        if (CacheableLocatorPromiseCache.useStatic) {
            CacheableLocatorPromiseCache.staticMap.delete(key);
        } else {
            this.normalMap.delete(key);
        }
    }
}

@injectable()
export abstract class CacheableLocatorService implements IInterpreterLocatorService {
    protected readonly _hasInterpreters: Deferred<boolean>;

    private readonly promisesPerResource = new CacheableLocatorPromiseCache();

    private readonly handlersAddedToResource = new Set<string>();

    private readonly cacheKeyPrefix: string;

    private readonly locating = new EventEmitter<Promise<PythonEnvironment[]>>();

    private _didTriggerInterpreterSuggestions: boolean;

    constructor(
        @unmanaged() private readonly name: string,
        @unmanaged() protected readonly serviceContainer: IServiceContainer,
        @unmanaged() private cachePerWorkspace: boolean = false,
    ) {
        this._hasInterpreters = createDeferred<boolean>();
        this.cacheKeyPrefix = `INTERPRETERS_CACHE_v3_${name}`;
        this._didTriggerInterpreterSuggestions = false;
    }

    public get didTriggerInterpreterSuggestions(): boolean {
        return this._didTriggerInterpreterSuggestions;
    }

    public set didTriggerInterpreterSuggestions(value: boolean) {
        this._didTriggerInterpreterSuggestions = value;
    }

    public get onLocating(): Event<Promise<PythonEnvironment[]>> {
        return this.locating.event;
    }

    public get hasInterpreters(): Promise<boolean> {
        return this._hasInterpreters.completed ? this._hasInterpreters.promise : Promise.resolve(false);
    }

    public abstract dispose(): void;

    @traceDecorators.verbose('Get Interpreters in CacheableLocatorService')
    public async getInterpreters(resource?: Uri, options?: GetInterpreterOptions): Promise<PythonEnvironment[]> {
        const cacheKey = this.getCacheKey(resource);
        let deferred = this.promisesPerResource.get(cacheKey);
        if (!deferred || options?.ignoreCache) {
            deferred = createDeferred<PythonEnvironment[]>();
            this.promisesPerResource.set(cacheKey, deferred);

            this.addHandlersForInterpreterWatchers(cacheKey, resource).ignoreErrors();

            const stopWatch = new StopWatch();
            this.getInterpretersImplementation(resource)
                .then(async (items) => {
                    await this.cacheInterpreters(items, resource);
                    traceVerbose(
                        `Interpreters returned by ${this.name} are of count ${Array.isArray(items) ? items.length : 0}`,
                    );
                    traceVerbose(`Interpreters returned by ${this.name} are ${JSON.stringify(items)}`);
                    sendTelemetryEvent(EventName.PYTHON_INTERPRETER_DISCOVERY, stopWatch.elapsedTime, {
                        interpreters: Array.isArray(items) ? items.length : 0,
                    });
                    deferred!.resolve(items);
                })
                .catch((ex) => {
                    sendTelemetryEvent(EventName.PYTHON_INTERPRETER_DISCOVERY, stopWatch.elapsedTime, {}, ex);
                    deferred!.reject(ex);
                });

            this.locating.fire(deferred.promise);
        }
        deferred.promise
            .then((items) => this._hasInterpreters.resolve(items.length > 0))
            .catch(() => this._hasInterpreters.resolve(false));

        if (deferred.completed) {
            return deferred.promise;
        }

        const cachedInterpreters = options?.ignoreCache ? undefined : this.getCachedInterpreters(resource);
        return Array.isArray(cachedInterpreters) ? cachedInterpreters : deferred.promise;
    }

    protected async addHandlersForInterpreterWatchers(cacheKey: string, resource: Uri | undefined): Promise<void> {
        if (this.handlersAddedToResource.has(cacheKey)) {
            return;
        }
        this.handlersAddedToResource.add(cacheKey);
        const watchers = await this.getInterpreterWatchers(resource);
        const disposableRegisry = this.serviceContainer.get<Disposable[]>(IDisposableRegistry);
        watchers.forEach((watcher) => {
            watcher.onDidCreate(
                () => {
                    traceVerbose(`Interpreter Watcher change handler for ${this.cacheKeyPrefix}`);
                    this.promisesPerResource.delete(cacheKey);
                    this.getInterpreters(resource).ignoreErrors();
                },
                this,
                disposableRegisry,
            );
        });
    }

    // eslint-disable-next-line class-methods-use-this
    protected async getInterpreterWatchers(_resource: Uri | undefined): Promise<IInterpreterWatcher[]> {
        return [];
    }

    protected abstract getInterpretersImplementation(resource?: Uri): Promise<PythonEnvironment[]>;

    protected createPersistenceStore(resource?: Uri): IPersistentState<PythonEnvironment[]> {
        const cacheKey = this.getCacheKey(resource);
        const persistentFactory = this.serviceContainer.get<IPersistentStateFactory>(IPersistentStateFactory);
        if (this.cachePerWorkspace) {
            return persistentFactory.createWorkspacePersistentState<PythonEnvironment[]>(cacheKey, undefined);
        }
        return persistentFactory.createGlobalPersistentState<PythonEnvironment[]>(cacheKey, undefined);
    }

    protected getCachedInterpreters(resource?: Uri): PythonEnvironment[] | undefined {
        const persistence = this.createPersistenceStore(resource);
        if (!Array.isArray(persistence.value)) {
            return undefined;
        }
        return persistence.value.map((item) => ({
            ...item,
            cachedEntry: true,
        }));
    }

    protected async cacheInterpreters(interpreters: PythonEnvironment[], resource?: Uri): Promise<void> {
        const persistence = this.createPersistenceStore(resource);
        await persistence.updateValue(interpreters);
    }

    protected getCacheKey(resource?: Uri): string {
        if (!resource || !this.cachePerWorkspace) {
            return this.cacheKeyPrefix;
        }
        // Ensure we have separate caches per workspace where necessary.Î
        const workspaceService = this.serviceContainer.get<IWorkspaceService>(IWorkspaceService);
        if (!Array.isArray(workspaceService.workspaceFolders)) {
            return this.cacheKeyPrefix;
        }

        const workspace = workspaceService.getWorkspaceFolder(resource);
        return workspace ? `${this.cacheKeyPrefix}:${md5(workspace.uri.fsPath)}` : this.cacheKeyPrefix;
    }
}
