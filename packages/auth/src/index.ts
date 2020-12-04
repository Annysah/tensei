import Dayjs from 'dayjs'
import Uniqid from 'uniqid'
import Bcrypt from 'bcryptjs'
import Jwt from 'jsonwebtoken'
import Randomstring from 'randomstring'
import ExpressSession from 'express-session'
import { validateAll } from 'indicative/validator'
import ExpressSessionMikroORMStore from 'express-session-mikro-orm'
import {
    plugin,
    resource,
    text,
    json,
    textarea,
    belongsTo,
    belongsToMany,
    dateTime,
    HookFunction,
    DataPayload,
    FieldContract,
    hasMany,
    boolean,
    select,
    Resolvers,
    graphQlQuery,
    GraphQlMiddleware,
    GraphQLPluginContext,
    route,
    GraphQlQueryContract,
    ApiContext,
    UserRole,
    Utils
} from '@tensei/common'

import {
    AuthData,
    TokenTypes,
    GrantConfig,
    AuthResources,
    AuthPluginConfig,
    SupportedSocialProviders,
    defaultProviderScopes
} from './config'
import SocialAuthCallbackController from './controllers/SocialAuthCallbackController'

import { setup } from './setup'

type JwtPayload = {
    id: string
    refresh?: boolean
}

type AuthSetupFn = (resources: AuthResources) => any

class Auth {
    private config: AuthPluginConfig & {
        setupFn: AuthSetupFn
    } = {
        profilePictures: false,
        userResource: 'User',
        roleResource: 'Role',
        disableCookies: false,
        permissionResource: 'Permission',
        passwordResetResource: 'Password Reset',
        fields: [],
        apiPath: 'auth',
        setupFn: () => this,
        tokensConfig: {
            accessTokenExpiresIn: 60 * 60,
            secretKey: process.env.JWT_SECRET || 'auth-secret-key',
            refreshTokenExpiresIn: 60 * 60 * 24 * 7
        },
        cookieOptions: {},
        refreshTokenCookieName: '___refresh__token',
        teams: false,
        teamFields: [],
        twoFactorAuth: false,
        verifyEmails: false,
        skipWelcomeEmail: false,
        rolesAndPermissions: false,
        providers: {}
    }

    private resources: AuthResources = {} as any

    public constructor() {
        this.refreshResources()
    }

    private refreshResources() {
        this.resources.user = this.userResource()
        this.resources.team = this.teamResource()
        this.resources.role = this.roleResource()
        this.resources.token = this.tokenResource()
        this.resources.oauthIdentity = this.oauthResource()
        this.resources.permission = this.permissionResource()
        this.resources.teamInvite = this.teamInviteResource()
        this.resources.passwordReset = this.passwordResetResource()

        this.config.setupFn(this.resources)
    }

    public afterUpdateUser(hook: HookFunction) {
        this.config.afterUpdateUser = hook

        return this
    }

    public noCookies() {
        this.config.disableCookies = true

        return this
    }

    public beforeLoginUser(hook: HookFunction) {
        this.config.beforeLoginUser = hook

        return this
    }

    public afterLoginUser(hook: HookFunction) {
        this.config.afterLoginUser = hook

        return this
    }

    public setup(fn: AuthSetupFn) {
        this.config.setupFn = fn

        return this
    }

    public user(name: string) {
        this.config.userResource = name

        return this
    }

    public verifyEmails() {
        this.config.verifyEmails = true

        return this
    }

    public configureTokens(config: Partial<AuthPluginConfig['tokensConfig']>) {
        this.config.tokensConfig = {
            ...this.config.tokensConfig,
            ...config
        }

        return this
    }

    public tokenExpiresIn(tokenExpiresIn: number) {
        this.config.tokensConfig.accessTokenExpiresIn = tokenExpiresIn

        return this
    }

    public tokenSecretKey(secret: string) {
        this.config.tokensConfig.secretKey = secret

        return this
    }

    public apiPath(path: string) {
        this.config.apiPath = path

        return this
    }

    public fields(fields: AuthPluginConfig['fields']) {
        this.config.fields = fields

        return this
    }

    public teamFields(fields: AuthPluginConfig['teamFields']) {
        this.config.teamFields = fields

        return this
    }

    public twoFactorAuth() {
        this.config.twoFactorAuth = true

        return this
    }

    public role(name: string) {
        this.config.roleResource = name

        return this
    }

    public permission(name: string) {
        this.config.permissionResource = name

        return this
    }

    public teams() {
        this.config.teams = true

        return this
    }

    public rolesAndPermissions() {
        this.config.rolesAndPermissions = true

        return this
    }

    private userResource() {
        let passwordField = text('Password')

        let socialFields: FieldContract[] = []

        if (Object.keys(this.config.providers).length === 0) {
            passwordField = passwordField.notNullable()
        } else {
            socialFields = [hasMany(this.resources.oauthIdentity.data.name)]
            passwordField = passwordField.nullable()
        }

        const userResource = resource(this.config.userResource)
            .fields([
                text('Email')
                    .unique()
                    .searchable()
                    .notNullable()
                    .creationRules('required', 'email', 'unique:email'),
                passwordField
                    .hidden()
                    .htmlAttributes({
                        type: 'password'
                    })
                    .creationRules('required')
                    .onlyOnForms()
                    .hideOnUpdate(),
                dateTime('Blocked At').nullable(),
                ...socialFields,
                ...(this.config.rolesAndPermissions
                    ? [belongsToMany(this.config.roleResource)]
                    : []),
                ...(this.config.twoFactorAuth
                    ? [
                          boolean('Two Factor Enabled')
                              .hideOnCreate()
                              .hideOnUpdate()
                              .hideOnIndex()
                              .hideOnDetail()
                              .nullable(),
                          text('Two Factor Secret')
                              .hidden()
                              .hideOnIndex()
                              .hideOnCreate()
                              .hideOnUpdate()
                              .hideOnDetail()
                              .nullable()
                      ]
                    : []),
                ...this.config.fields,
                ...(this.config.verifyEmails
                    ? [
                          dateTime('Email Verified At')
                              .hideOnIndex()
                              .hideOnDetail()
                              .nullable(),
                          text('Email Verification Token')
                              .hidden()
                              .nullable()
                              .hideOnCreate()
                              .hideOnIndex()
                              .hideOnUpdate()
                              .hideOnDetail()
                      ]
                    : [])
            ])
            .beforeCreate(async ({ entity, em }) => {
                const payload: DataPayload = {
                    password: entity.password
                        ? Bcrypt.hashSync(entity.password)
                        : undefined
                }

                if (this.config.verifyEmails) {
                    payload.email_verified_at = null
                    payload.email_verification_token = this.generateRandomToken()
                }

                em.assign(entity, payload)
            })
            .beforeUpdate(async ({ entity, em, changeSet }) => {
                if (changeSet?.payload.password) {
                    em.assign(entity, {
                        password: Bcrypt.hashSync(changeSet.payload.password)
                    })
                }
            })
            .group('Users & Permissions')

        return userResource
    }

    private tokenResource() {
        return resource('Token').fields([
            text('Token').notNullable().hidden().searchable().unique(),
            text('Name').searchable().nullable(),
            select('Type')
                .options([
                    {
                        label: 'Refresh Token',
                        value: 'REFRESH'
                    },
                    {
                        label: 'API Token',
                        value: 'API'
                    }
                ])
                .searchable()
                .nullable(),
            dateTime('Last Used At').nullable(),
            dateTime('Compromised At').nullable(),
            dateTime('Expires At').hidden(),
            belongsTo(this.config.userResource).nullable()
        ])
    }

    private teamResource() {
        return resource('Team')
            .fields([
                text('Name').unique(),
                belongsTo(this.config.userResource),
                belongsToMany(this.config.userResource),
                ...this.config.teamFields
            ])
            .hideFromNavigation()
    }

    private teamInviteResource() {
        return resource('Team Invite').fields([
            text('Email'),
            text('Role'),
            text('Token').unique().rules('required'),
            belongsTo(this.resources.team.data.name),
            belongsTo(this.config.userResource)
        ])
    }

    private permissionResource() {
        return resource(this.config.permissionResource)
            .fields([
                text('Name').searchable().rules('required'),
                text('Slug')
                    .rules('required')
                    .unique()
                    .searchable()
                    .rules('required'),
                belongsToMany(this.config.roleResource)
            ])
            .displayField('name')
            .group('Users & Permissions')
    }

    private roleResource() {
        return resource(this.config.roleResource)
            .fields([
                text('Name')
                    .rules('required')
                    .unique()
                    .searchable()
                    .rules('required'),
                text('Slug')
                    .rules('required')
                    .unique()
                    .searchable()
                    .hideOnUpdate()
                    .rules('required'),
                belongsToMany(this.config.userResource),
                belongsToMany(this.config.permissionResource)
            ])
            .displayField('name')
            .group('Users & Permissions')
    }

    private passwordResetResource() {
        return resource(this.config.passwordResetResource)
            .hideFromNavigation()
            .fields([
                text('Email').searchable().unique().notNullable(),
                text('Token').unique().notNullable().hidden(),
                dateTime('Expires At')
            ])
            .hideFromApi()
    }

    private oauthResource() {
        return resource('Oauth Identity')
            .hideFromNavigation()
            .fields([
                belongsTo(this.config.userResource).nullable(),
                textarea('Access Token').hidden().hideFromApi(),
                text('Email').hidden(),
                textarea('Temporal Token').nullable().hidden(),
                json('Payload').hidden().hideFromApi(),
                text('Provider').rules('required'),
                text('Provider User ID').hidden()
            ])
    }

    public plugin() {
        return plugin('Auth')
            .register(
                ({
                    gql,
                    extendRoutes,
                    databaseConfig,
                    extendResources,
                    extendGraphQlTypeDefs,
                    extendGraphQlQueries,
                    extendGraphQlMiddleware
                }) => {
                    this.refreshResources()

                    extendResources([
                        this.resources.user,
                        this.resources.token,
                        this.resources.passwordReset
                    ])

                    if (this.config.rolesAndPermissions) {
                        extendResources([
                            this.resources.role,
                            this.resources.permission
                        ])
                    }

                    if (this.config.teams) {
                        extendResources([
                            this.resources.team,
                            this.resources.teamInvite
                        ])
                    }

                    if (Object.keys(this.config.providers).length > 0) {
                        extendResources([this.resources.oauthIdentity])
                    }

                    if (
                        !this.config.disableCookies ||
                        this.socialAuthEnabled()
                    ) {
                        databaseConfig.entities = [
                            ...(databaseConfig.entities || []),
                            require('express-session-mikro-orm').generateSessionEntity()
                        ]
                    }

                    extendGraphQlTypeDefs([this.extendGraphQLTypeDefs(gql)])
                    extendGraphQlQueries(this.extendGraphQlQueries())
                    extendRoutes(this.extendRoutes())

                    extendGraphQlMiddleware([
                        graphQlQueries => {
                            const resolverAuthorizers: Resolvers = {
                                Query: {},
                                Mutation: {}
                            }

                            const getAuthorizer = (
                                query: GraphQlQueryContract
                            ): GraphQlMiddleware => {
                                return async (
                                    resolve,
                                    parent,
                                    args,
                                    context,
                                    info
                                ) => {
                                    await this.getAuthUserFromContext(context)
                                    await this.setAuthUserForPublicRoutes(
                                        context
                                    )
                                    await this.ensureAuthUserIsNotBlocked(
                                        context
                                    )
                                    await this.authorizeResolver(context, query)

                                    const result = await resolve(
                                        parent,
                                        args,
                                        context,
                                        info
                                    )

                                    return result
                                }
                            }

                            graphQlQueries.forEach(query => {
                                if (query.config.type === 'QUERY') {
                                    ;(resolverAuthorizers.Query as any)[
                                        query.config.path
                                    ] = getAuthorizer(query)
                                }

                                if (query.config.type === 'MUTATION') {
                                    ;(resolverAuthorizers.Mutation as any)[
                                        query.config.path
                                    ] = getAuthorizer(query)
                                }

                                if (query.config.type === 'SUBSCRIPTION') {
                                    query.middleware([
                                        async (parent, args, ctx, info) => {
                                            const authorizationToken =
                                                ctx.connection?.context
                                                    ?.Authorization

                                            if (!authorizationToken) {
                                                return
                                            }

                                            await this.populateContextFromToken(
                                                authorizationToken.split(
                                                    ' '
                                                )[1],
                                                ctx
                                            )
                                        },
                                        async (parent, args, ctx, info) =>
                                            this.setAuthUserForPublicRoutes(
                                                ctx
                                            ),
                                        async (parent, args, ctx, info) =>
                                            this.ensureAuthUserIsNotBlocked(ctx)
                                    ])
                                }
                            })

                            return resolverAuthorizers
                        }
                    ])
                }
            )

            .boot(async config => {
                if (this.config.rolesAndPermissions) {
                    await setup(config, [
                        this.resources.role,
                        this.resources.permission
                    ])
                }

                const {
                    app,
                    serverUrl,
                    clientUrl,
                    graphQlQueries,
                    routes,
                    apiPath
                } = config

                const Store = ExpressSessionMikroORMStore(ExpressSession)

                app.use(
                    ExpressSession({
                        store: new Store({
                            orm: config.orm
                        }) as any,
                        resave: false,
                        saveUninitialized: false,
                        cookie: this.config.cookieOptions,
                        secret:
                            process.env.SESSION_SECRET || '__sessions__secret__'
                    })
                )

                if (this.socialAuthEnabled()) {
                    const grant = require('grant')

                    Object.keys(this.config.providers).forEach(provider => {
                        const providerConfig = this.config.providers[provider]
                        const clientCallback =
                            providerConfig.clientCallback || ''

                        this.config.providers[provider] = {
                            ...providerConfig,
                            redirect_uri: `${serverUrl}/connect/${provider}/callback`,
                            clientCallback: clientCallback.startsWith('http')
                                ? clientCallback
                                : `${clientUrl}${
                                      clientCallback.startsWith('/') ? '/' : ''
                                  }${clientCallback}`
                        }
                    })

                    app.use(grant.express()(this.config.providers))

                    app.get(
                        `/${this.config.apiPath}/:provider/callback`,
                        SocialAuthCallbackController.connect({
                            ...this.config,
                            resources: this.resources
                        })
                    )
                }

                graphQlQueries.forEach(query => {
                    if (query.config.resource) {
                        const { path, internal } = query.config
                        const {
                            snakeCaseNamePlural: plural,
                            snakeCaseName: singular,
                            slug
                        } = query.config.resource.data

                        if (!internal) {
                            return
                        }

                        if (
                            [`insert_${plural}`, `insert_${singular}`].includes(
                                path
                            )
                        ) {
                            return query.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `insert:${slug}`
                                    )
                            )
                        }

                        if (
                            [`delete_${plural}`, `delete_${singular}`].includes(
                                path
                            )
                        ) {
                            return query.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `delete:${slug}`
                                    )
                            )
                        }

                        if (
                            [`update_${plural}`, `update_${singular}`].includes(
                                path
                            )
                        ) {
                            return query.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `update:${slug}`
                                    )
                            )
                        }

                        if (path === plural) {
                            return query.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `fetch:${slug}`
                                    )
                            )
                        }

                        if (path === singular) {
                            return query.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `show:${slug}`
                                    )
                            )
                        }
                    }
                })

                routes.forEach(route => {
                    route.middleware([
                        async (request, response, next) => {
                            await this.getAuthUserFromContext(request as any)

                            return next()
                        },
                        async (request, response, next) => {
                            await this.setAuthUserForPublicRoutes(
                                request as any
                            )

                            return next()
                        },
                        async (request, response, next) => {
                            await this.ensureAuthUserIsNotBlocked(
                                request as any
                            )

                            return next()
                        },
                        async (request, response, next) => {
                            const authorizers = await Promise.all(
                                route.config.authorize.map(fn =>
                                    fn(request as any)
                                )
                            )

                            if (
                                authorizers.filter(authorized => authorized)
                                    .length !== route.config.authorize.length
                            ) {
                                throw request.forbiddenError('Unauthorized.')
                            }

                            next()
                        }
                    ])
                    if (route.config.resource) {
                        const { resource, path, type, internal } = route.config

                        const { slugSingular, slugPlural } = resource.data

                        route.extend({
                            ...route.config.extend,
                            docs: {
                                ...route.config.extend?.docs,
                                security: [
                                    {
                                        Bearer: []
                                    }
                                ]
                            }
                        })

                        if (
                            path === `/${apiPath}/${slugPlural}` &&
                            type === 'POST' &&
                            internal
                        ) {
                            return route.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `insert:${slugSingular}`
                                    )
                            )
                        }

                        if (
                            path === `/${apiPath}/${slugPlural}` &&
                            type === 'GET' &&
                            internal
                        ) {
                            return route.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `fetch:${slugSingular}`
                                    )
                            )
                        }

                        if (
                            path === `/${apiPath}/${slugPlural}/:id` &&
                            type === 'GET' &&
                            internal
                        ) {
                            return route.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `show:${slugSingular}`
                                    )
                            )
                        }

                        if (
                            [
                                `/${apiPath}/${slugPlural}/:id`,
                                `/${apiPath}/${slugPlural}`
                            ].includes(path) &&
                            ['PUT', 'PATCH'].includes(type) &&
                            internal
                        ) {
                            return route.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]?.includes(
                                        `update:${slugSingular}`
                                    )
                            )
                        }

                        if (
                            [
                                `/${apiPath}/${slugPlural}/:id`,
                                `/${apiPath}/${slugPlural}`
                            ].includes(path) &&
                            type === 'DELETE' &&
                            internal
                        ) {
                            return route.authorize(
                                ({ user }) =>
                                    user &&
                                    user[this.getPermissionUserKey()]!.includes(
                                        `delete:${slugSingular}`
                                    )
                            )
                        }
                    }
                })
            })
    }

    private getRegistrationFieldsDocs() {
        const properties: any = {}

        // TODO: Calculate and push new registration fields to be exposed to API

        return properties
    }

    private extendRoutes() {
        const name = this.resources.user.data.slugSingular

        const extend = {
            tags: ['Auth']
        }

        return [
            route(`Login ${name}`)
                .path(this.getApiPath('login'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Login an existing ${name}.`,
                        parameters: [
                            {
                                required: true,
                                type: 'object',
                                name: 'body',
                                in: 'body',
                                schema: {
                                    $ref: `#/definitions/LoginInput`
                                }
                            }
                        ],
                        definitions: {
                            LoginInput: {
                                type: 'object',
                                properties: {
                                    email: {
                                        required: true,
                                        type: 'string',
                                        format: 'email'
                                    },
                                    password: {
                                        required: true,
                                        type: 'string'
                                    }
                                }
                            }
                        }
                    }
                })
                .handle(async (request, { formatter: { ok, unprocess } }) => {
                    try {
                        return ok(await this.login(request as any))
                    } catch (error) {
                        return unprocess(error)
                    }
                }),
            route(`Register ${name}`)
                .path(this.getApiPath('register'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Register a new ${name}.`,
                        parameters: [
                            {
                                required: true,
                                type: 'object',
                                name: 'body',
                                in: 'body',
                                schema: {
                                    $ref: `#/definitions/RegisterInput`
                                }
                            }
                        ],
                        definitions: {
                            RegisterInput: {
                                type: 'object',
                                properties: {
                                    email: {
                                        required: true,
                                        type: 'string',
                                        format: 'email'
                                    },
                                    password: {
                                        required: true,
                                        type: 'string'
                                    },
                                    ...this.getRegistrationFieldsDocs()
                                }
                            }
                        }
                    }
                })
                .handle(
                    async (request, { formatter: { created, unprocess } }) => {
                        try {
                            return created(await this.register(request as any))
                        } catch (error) {
                            return unprocess(error)
                        }
                    }
                ),
            route(`Request password reset`)
                .path(this.getApiPath('passwords/email'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Request a password reset for a ${name} using the ${name} email.`,
                        parameters: [
                            {
                                required: true,
                                type: 'object',
                                name: 'body',
                                in: 'body',
                                schema: {
                                    $ref: `#/definitions/RequestPasswordInput`
                                }
                            }
                        ],
                        definitions: {
                            RequestPasswordInput: {
                                properties: {
                                    email: {
                                        type: 'string',
                                        required: true,
                                        format: 'email'
                                    }
                                }
                            }
                        }
                    }
                })
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.forgotPassword(request as any)
                    )
                ),

            route(`Reset password`)
                .path(this.getApiPath('passwords/reset'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Reset a ${name} password using a password reset token.`,
                        parameters: [
                            {
                                required: true,
                                type: 'object',
                                name: 'body',
                                in: 'body',
                                schema: {
                                    $ref: `#/definitions/ResetPasswordInput`
                                }
                            }
                        ],
                        definitions: {
                            ResetPasswordInput: {
                                properties: {
                                    password: {
                                        type: 'string',
                                        required: true
                                    },
                                    token: {
                                        type: 'string',
                                        required: true,
                                        description: `This token was sent to the ${name}'s email. Provide it here to reset the ${name}'s password.`
                                    }
                                }
                            }
                        }
                    }
                })
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.resetPassword(request as any)
                    )
                ),
            route(`Enable Two Factor Auth`)
                .path(this.getApiPath('two-factor/enable'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Enable two factor authentication for an existing ${name}.`
                    }
                })
                .authorize(({ user }) => user && !user.public)
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.enableTwoFactorAuth(request as any)
                    )
                ),
            route(`Confirm Enable Two Factor Auth`)
                .path(this.getApiPath('two-factor/enable/confirm'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Confirm enable two factor authentication for an existing ${name}.`,
                        description: `This endpoint confirms enabling 2fa for an account. A previous call to /${this.config.apiPath}/two-factor/enable is required to generate a 2fa secret for the ${name}'s account.`
                    }
                })
                .authorize(({ user }) => user && !user.public)
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.enableTwoFactorAuth(request as any)
                    )
                ),
            route(`Disable Two Factor Auth`)
                .path(this.getApiPath('two-factor/disable'))
                .post()
                .authorize(({ user }) => user && !user.public)
                .extend({
                    docs: {
                        ...extend,
                        summary: `Disable two factor authentication for an existing ${name}.`
                    }
                })
                .authorize(({ user }) => !!user)
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.disableTwoFactorAuth(request as any)
                    )
                ),
            route(`Get authenticated ${name}`)
                .path(this.getApiPath('me'))
                .get()
                .authorize(({ user }) => user && !user.public)
                .extend({
                    docs: {
                        ...extend,
                        summary: `Get the authenticated ${name} from a valid JWT.`,
                        security: [
                            {
                                Bearer: []
                            }
                        ]
                    }
                })
                .handle(async ({ user }, { formatter: { ok } }) => ok(user)),
            route(`Resend Verification email`)
                .path(this.getApiPath('verification/resend'))
                .post()
                .authorize(({ user }) => user && !user.public)
                .extend({
                    docs: {
                        ...extend,
                        summary: `Resend verification email to ${name} email.`
                    }
                })
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.resendVerificationEmail(request as any)
                    )
                ),
            route(`Social Auth Login`)
                .path(this.getApiPath('social/login'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Login a ${name} via a social provider.`,
                        description: `This operation requires an access_token gotten after a redirect from the social provider.`
                    }
                })
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.socialAuth(request as any, 'login')
                    )
                ),
            route(`Social Auth Register`)
                .path(this.getApiPath('social/register'))
                .post()
                .extend({
                    docs: {
                        ...extend,
                        summary: `Register a ${name} via a social provider.`,
                        description: `This operation requires an access_token gotten after a redirect from the social provider.`
                    }
                })
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.socialAuth(request as any, 'register')
                    )
                ),
            route('Refresh Token')
                .path(this.getApiPath('refresh-token'))
                .post()
                .authorize(({ user }) => user && !user.public)
                .extend({
                    docs: {
                        ...extend,
                        summary: `Request a new (access token) using a refresh token.`,
                        description: `The refresh token is set in cookies response for all endpoints that return an access token (login, register).`,
                        parameters: [
                            {
                                name: this.config.refreshTokenCookieName,
                                required: true,
                                in: 'cookie'
                            }
                        ]
                    }
                })
                .handle(
                    async (request, { formatter: { ok, unauthorized } }) => {
                        try {
                            return ok(
                                await this.handleRefreshTokens(request as any)
                            )
                        } catch (error) {
                            return unauthorized({
                                message:
                                    error.message || 'Invalid refresh token.'
                            })
                        }
                    }
                ),
            route('Remove refresh Token')
                .path(this.getApiPath('refresh-token'))
                .delete()
                .authorize(({ user }) => user && !user.public)
                .extend({
                    docs: {
                        ...extend,
                        summary: `Invalidate a refresh token.`,
                        description: `Sets the refresh token cookie to an invalid value and expires it.`,
                        parameters: [
                            {
                                name: this.config.refreshTokenCookieName,
                                required: true,
                                in: 'cookie'
                            }
                        ]
                    }
                })
                .handle(async (request, response) =>
                    response.formatter.ok(
                        await this.removeRefreshTokens(request as any)
                    )
                )
        ]
    }

    cookieOptions(cookieOptions: AuthPluginConfig['cookieOptions']) {
        this.config.cookieOptions = cookieOptions

        return this
    }

    private extendGraphQlQueries() {
        const name = this.resources.user.data.snakeCaseName

        return [
            graphQlQuery(`Login ${name}`)
                .path(`login_${name}`)
                .mutation()
                .handle(async (_, args, ctx, info) => this.login(ctx)),
            ...(this.config.disableCookies
                ? []
                : [
                      graphQlQuery(`Logout ${name}`)
                          .path(`logout_${name}`)
                          .mutation()
                          .handle(async (_, args, ctx) => {
                              return new Promise(resolve => {
                                  ctx.req.session.destroy(error => {
                                      if (error) {
                                          return resolve(false)
                                      }

                                      ctx.res.clearCookie('connect.sid')

                                      return resolve(true)
                                  })
                              })
                          })
                  ]),
            graphQlQuery(`Register ${name}`)
                .path(`register_${name}`)
                .mutation()
                .handle(async (_, args, ctx, info) => this.register(ctx)),
            graphQlQuery(`Request password reset`)
                .path('request_password_reset')
                .mutation()
                .handle(async (_, args, ctx, info) => this.forgotPassword(ctx)),
            graphQlQuery(`Reset password`)
                .path('reset_password')
                .mutation()
                .handle(async (_, args, ctx, info) => this.resetPassword(ctx)),
            graphQlQuery(
                `Get authenticated ${this.resources.user.data.snakeCaseName}`
            )
                .path(`authenticated_${this.resources.user.data.snakeCaseName}`)
                .query()
                .authorize(({ user }) => user && !user.public)
                .handle(async (_, args, ctx, info) => ctx.user),
            ...(this.config.twoFactorAuth
                ? [
                      graphQlQuery(`Enable Two Factor Auth`)
                          .path('enable_two_factor_auth')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.enableTwoFactorAuth(ctx)
                          )
                          .authorize(({ user }) => user && !user.public),
                      graphQlQuery('Confirm Enable Two Factor Auth')
                          .path('confirm_enable_two_factor_auth')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.confirmEnableTwoFactorAuth(ctx)
                          )
                          .authorize(({ user }) => user && !user.public),

                      graphQlQuery(`Disable Two Factor Auth`)
                          .path('disable_two_factor_auth')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.disableTwoFactorAuth(ctx)
                          )
                          .authorize(({ user }) => user && !user.public)
                  ]
                : []),
            ...(this.config.verifyEmails
                ? [
                      graphQlQuery('Confirm Email')
                          .path('confirm_email')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.confirmEmail(ctx)
                          )
                          .authorize(({ user }) => user && !user.public),
                      graphQlQuery('Resend Verification Email')
                          .path('resend_verification_email')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.resendVerificationEmail(ctx)
                          )
                  ]
                : []),
            ...(this.socialAuthEnabled()
                ? [
                      graphQlQuery('Social auth login')
                          .path('social_auth_login')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.socialAuth(ctx, 'login')
                          ),
                      graphQlQuery('Social auth register')
                          .path('social_auth_register')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.socialAuth(ctx, 'register')
                          )
                  ]
                : []),
            ...(this.config.disableCookies
                ? [
                      graphQlQuery('Refresh token')
                          .path('refresh_token')
                          .mutation()
                          .handle(async (_, args, ctx, info) =>
                              this.handleRefreshTokens(ctx)
                          )
                  ]
                : [])
        ]
    }

    private async removeRefreshTokens(ctx: ApiContext) {
        ctx.res.cookie(this.config.refreshTokenCookieName, '', {
            ...this.config.cookieOptions,
            httpOnly: true,
            maxAge: 0
        })

        return true
    }

    private async handleRefreshTokens(ctx: ApiContext) {
        const { body } = ctx
        const userField = this.resources.user.data.snakeCaseName
        const tokenName = this.resources.token.data.pascalCaseName

        const refreshToken =
            (ctx.req.cookies
                ? ctx.req.cookies[this.config.refreshTokenCookieName]
                : undefined) ||
            (body
                ? body.object
                    ? body.object.refresh_token
                    : body.refresh_token
                : undefined)

        if (!refreshToken) {
            throw ctx.authenticationError('Invalid refresh token.')
        }

        const token: any = await ctx.manager.findOne(
            tokenName,
            {
                token: refreshToken,
                type: TokenTypes.REFRESH
            },
            {
                populate: [
                    `${userField}${
                        this.config.rolesAndPermissions
                            ? `.${this.getRolesAndPermissionsNames()}`
                            : ''
                    }`
                ]
            }
        )

        if (!token) {
            throw ctx.authenticationError('Invalid refresh token.')
        }

        if (token.last_used_at) {
            // This token has been used before.
            // We'll block the user's access to the API by marking this refresh token as compromised.
            // Human interaction is required to lift this limit, something like deleting the compromised tokens.

            ctx.manager.assign(token, {
                compromised_at: Dayjs().format()
            })

            ctx.manager.assign(token[userField], {
                blocked_at: Dayjs().format()
            })

            ctx.manager.persist(token)
            ctx.manager.persist(token[userField])

            await ctx.manager.flush()

            throw ctx.authenticationError('Invalid refresh token.')
        }

        if (!token[userField] || Dayjs(token.expires_on).isBefore(Dayjs())) {
            token && (await ctx.manager.removeAndFlush(token))

            throw ctx.authenticationError('Invalid refresh token.')
        }

        ctx.manager.assign(token, {
            last_used_at: Dayjs().format(),
            expires_at: Dayjs().subtract(1, 'second').format()
        })

        await ctx.manager.persistAndFlush(token)

        ctx.user = token[userField]

        return this.getUserPayload(
            ctx,
            await this.generateRefreshToken(ctx, token.expires_on)
        )
    }

    private getUserPayload(ctx: ApiContext, refreshToken?: string) {
        let userPayload: any = {
            [this.resources.user.data.snakeCaseName]: ctx.user
        }

        if (this.config.disableCookies) {
            userPayload.access_token = this.generateJwt({
                id: ctx.user.id
            })

            userPayload.refresh_token = refreshToken
            userPayload.expires_in = this.config.tokensConfig.accessTokenExpiresIn
        }

        return userPayload
    }

    private extendGraphQLTypeDefs(gql: any) {
        const snakeCaseName = this.resources.user.data.snakeCaseName

        return gql`
        type register_${snakeCaseName}_response {
            ${
                this.config.disableCookies
                    ? `
                access_token: String!
                refresh_token: String
                expires_in: Int!
            `
                    : ''
            }
            ${snakeCaseName}: ${snakeCaseName}!
        }

        type login_${snakeCaseName}_response {
            ${
                this.config.disableCookies
                    ? `
                access_token: String!
                refresh_token: String
                expires_in: Int!
            `
                    : ''
            }
            ${snakeCaseName}: ${snakeCaseName}!
        }

        input login_${snakeCaseName}_input {
            email: String!
            password: String!
        }

        input request_password_reset_input {
            email: String!
        }

        input reset_password_input {
            email: String!
            """ The reset password token sent to ${snakeCaseName}'s email """
            token: String!
            password: String!
        }

        ${
            this.config.twoFactorAuth
                ? `
        type enable_two_factor_auth_response {
            """ The data url for the qr code. Display this in an <img /> tag to be scanned on the authenticator app """
            dataURL: String!
        }

        input confirm_enable_two_factor_auth_input {
            """ The two factor auth token from the ${snakeCaseName}'s authenticator app """
            token: Int!
        }

        input disable_two_factor_auth_input {
            """ The two factor auth token from the ${snakeCaseName}'s authenticator app """
            token: Int!
        }
        `
                : ''
        }

        ${
            this.config.verifyEmails
                ? `
        input confirm_email_input {
            """ The email verification token sent to the ${snakeCaseName}'s email """
            email_verification_token: String!
        }
        `
                : ''
        }

        ${
            this.socialAuthEnabled()
                ? `
        input social_auth_register_input {
            """ The temporal access token received in query parameter when user is redirected """
            access_token: String!
        }

        input social_auth_login_input {
            """ The temporal access token received in query parameter when user is redirected """
            access_token: String!
        }
        `
                : ''
        }

        extend input create_${snakeCaseName}_input {
            password: String!
        }

        ${
            this.config.disableCookies
                ? `
        input refresh_token_input {
            refresh_token: String
        }
        `
                : ''
        }

        extend type Mutation {
            login_${snakeCaseName}(object: login_${snakeCaseName}_input!): login_${snakeCaseName}_response!
            ${
                !this.config.disableCookies
                    ? `
            logout_${snakeCaseName}: Boolean!
            `
                    : ``
            }
            register_${snakeCaseName}(object: create_${snakeCaseName}_input!): register_${snakeCaseName}_response!
            request_password_reset(object: request_password_reset_input!): Boolean!
            reset_password(object: reset_password_input!): Boolean!
            ${
                this.config.twoFactorAuth
                    ? `
            enable_two_factor_auth: enable_two_factor_auth_response!
            disable_two_factor_auth(object: disable_two_factor_auth_input!): ${snakeCaseName}!
            confirm_enable_two_factor_auth(object: confirm_enable_two_factor_auth_input!): ${snakeCaseName}!
            `
                    : ''
            }
            ${
                this.config.verifyEmails
                    ? `
            confirm_email(object: confirm_email_input!): ${snakeCaseName}!
            resend_verification_email: Boolean
            `
                    : ''
            }
            ${
                this.socialAuthEnabled()
                    ? `
            social_auth_register(object: social_auth_register_input!): register_${snakeCaseName}_response!
            social_auth_login(object: social_auth_login_input!): login_${snakeCaseName}_response!
            `
                    : ''
            }
            ${
                this.config.disableCookies
                    ? `
            refresh_token(object: refresh_token_input): login_${snakeCaseName}_response!
            `
                    : ''
            }
        }

        extend type Query {
            authenticated_${snakeCaseName}: ${snakeCaseName}!
        }
    `
    }

    private socialAuthEnabled() {
        return Object.keys(this.config.providers).length > 0
    }

    private getApiPath(path: string) {
        return `/${this.config.apiPath}/${path}`
    }

    private getRolesAndPermissionsNames() {
        return `${this.resources.role.data.snakeCaseNamePlural}.${this.resources.permission.data.snakeCaseName}`
    }

    private register = async (ctx: ApiContext) => {
        const { manager, mailer, body } = ctx

        const validator = Utils.validator(
            this.resources.user,
            ctx.manager,
            ctx.resourcesMap
        )

        let [success, createUserPayload] = await validator.validate(
            body.object ? body.object : body
        )

        if (!success) {
            throw ctx.userInputError('Validation failed.', {
                errors: createUserPayload
            })
        }

        if (this.config.rolesAndPermissions) {
            const authenticatorRole: any = await manager.findOneOrFail(
                this.resources.role.data.pascalCaseName,
                {
                    slug: 'authenticated'
                }
            )

            if (!authenticatorRole) {
                throw {
                    status: 400,
                    message:
                        'The authenticated role must be created to use roles and permissions.'
                }
            }

            createUserPayload.roles = [authenticatorRole.id]
        }

        const UserResource = this.resources.user

        const user: any = manager.create(
            UserResource.data.pascalCaseName,
            createUserPayload
        )

        await manager.persistAndFlush(user)

        if (this.config.rolesAndPermissions) {
            await manager.populate([user], [this.getRolesAndPermissionsNames()])
        }

        ctx.user = user

        if (!this.config.disableCookies) {
            ctx.req.session.user = {
                id: user.id
            }
        }

        if (this.config.verifyEmails && !this.config.skipWelcomeEmail) {
            mailer
                .to(user.email)
                .sendRaw(
                    `Please verify your email using this link: ${user.email_verification_token}`
                )
        }

        const refreshToken = await this.generateRefreshToken(ctx)

        return this.getUserPayload(ctx, refreshToken)
    }

    private resendVerificationEmail = async ({
        manager,
        user,
        mailer
    }: ApiContext) => {
        if (!user.email_verification_token) {
            return false
        }

        manager.assign(user, {
            email_verification_token: this.generateRandomToken()
        })

        await manager.persistAndFlush(user)

        mailer.to(user.email).sendRaw(`
            Please verify your email using this link: ${user.email_verification_token}
        `)

        return true
    }

    private confirmEmail = async (ctx: ApiContext) => {
        const { manager, body, user } = ctx
        if (
            user.email_verification_token ===
            (body.object
                ? body.object.email_verification_token
                : body.email_verification_token)
        ) {
            manager.assign(user, {
                email_verification_token: null,
                email_verified_at: Dayjs().format()
            })

            await manager.persistAndFlush(user)

            return user.toJSON()
        }

        throw ctx.userInputError('Invalid email verification token.')
    }

    private socialAuth = async (
        ctx: ApiContext,
        action: 'login' | 'register'
    ) => {
        const { body, manager } = ctx
        const access_token = body.object
            ? body.object.access_token
            : body.access_token

        if (!access_token) {
            throw ctx.userInputError('Validation failed.', [
                {
                    field: 'access_token',
                    message: 'Invalid access token provided.'
                }
            ])
        }

        let oauthIdentity: any = await manager.findOne(
            this.resources.oauthIdentity.data.pascalCaseName,
            {
                temporal_token: access_token
            }
        )

        if (!oauthIdentity) {
            throw ctx.userInputError('Validation failed.', [
                {
                    field: 'access_token',
                    message: 'Invalid access token provided.'
                }
            ])
        }

        const oauthPayload = JSON.parse(oauthIdentity.payload)

        let user: any = await manager.findOne(
            this.resources.user.data.pascalCaseName,
            {
                email: oauthPayload.email
            }
        )

        if (!user && action === 'login') {
            throw ctx.userInputError('Validation failed.', [
                {
                    field: 'email',
                    message: 'Cannot find a user with these credentials.'
                }
            ])
        }

        if (user && action === 'register') {
            throw ctx.userInputError('Validation failed.', [
                {
                    field: 'email',
                    message: `A ${this.resources.user.data.snakeCaseName.toLowerCase()} already exists with email ${
                        oauthIdentity.email
                    }.`
                }
            ])
        }

        if (!user && action === 'register') {
            let createPayload: DataPayload = {
                ...oauthPayload
            }

            if (this.config.verifyEmails) {
                createPayload.email_verified_at = Dayjs().format(
                    'YYYY-MM-DD HH:mm:ss'
                )
                createPayload.email_verification_token = null
            }

            user = manager.create(
                this.resources.user.data.pascalCaseName,
                createPayload
            )

            await manager.persistAndFlush(user)
        }

        const belongsToField = this.resources.oauthIdentity.data.fields.find(
            field => field.name === this.resources.user.data.pascalCaseName
        )!

        manager.assign(oauthIdentity, {
            temporal_token: null,
            [belongsToField.databaseField]: user.id
        })

        await manager.flush()

        return this.getUserPayload(ctx, await this.generateRefreshToken(ctx))
    }

    private login = async (ctx: ApiContext) => {
        const { manager, body } = ctx
        const { email, password, token } = await this.validate(
            body.object ? body.object : body
        )

        const user: any = await manager.findOne(
            this.resources.user.data.pascalCaseName,
            {
                email
            },
            {
                populate: this.config.rolesAndPermissions
                    ? [this.getRolesAndPermissionsNames()]
                    : []
            }
        )

        if (!user) {
            throw ctx.authenticationError('Invalid credentials.')
        }

        if (user.blocked_at) {
            throw ctx.forbiddenError('Your account is temporarily disabled.')
        }

        if (!Bcrypt.compareSync(password, user.password)) {
            throw ctx.authenticationError('Invalid credentials.')
        }

        if (this.config.twoFactorAuth && user.two_factor_enabled) {
            const Speakeasy = require('speakeasy')

            if (!token) {
                throw ctx.userInputError(
                    'The two factor authentication token is required.'
                )
            }

            const verified = Speakeasy.totp.verify({
                token,
                encoding: 'base32',
                secret: user.two_factor_secret
            })

            if (!verified) {
                throw ctx.userInputError(
                    'Invalid two factor authentication token.'
                )
            }
        }

        if (!this.config.disableCookies) {
            ctx.req.session.user = {
                id: user.id
            }
        }

        ctx.user = user

        return this.getUserPayload(ctx, await this.generateRefreshToken(ctx))
    }

    public authorizeResolver = async (
        ctx: GraphQLPluginContext,
        query: GraphQlQueryContract
    ) => {
        const authorized = await Promise.all(
            query.config.authorize.map(fn => fn(ctx))
        )

        if (
            authorized.filter(result => result).length !==
            query.config.authorize.length
        ) {
            throw ctx.forbiddenError('Unauthorized.')
        }
    }

    public setAuthUserForPublicRoutes = async (ctx: GraphQLPluginContext) => {
        const { manager, user } = ctx

        if (!this.config.rolesAndPermissions) {
            return
        }

        const publicRole: any = await manager.findOne(
            this.resources.role.data.pascalCaseName,
            {
                slug: 'public'
            },
            {
                populate: ['permissions'],
                refresh: true
            }
        )

        if (!user) {
            ctx.user = {
                public: true,
                [this.getRoleUserKey()]: [publicRole as UserRole],
                [this.getPermissionUserKey()]: publicRole[
                    this.getPermissionUserKey()
                ]
                    .toJSON()
                    .map((permission: any) => permission.slug)
            } as any
        }
    }

    private ensureAuthUserIsNotBlocked = async (ctx: ApiContext) => {
        if (!ctx.user || (ctx.user && ctx.user.public)) {
            return
        }

        if (ctx.user.blocked_at) {
            throw ctx.forbiddenError('Your account is temporarily disabled.')
        }
    }

    private populateContextFromToken = async (
        token: string,
        ctx: ApiContext,
        userId?: number
    ) => {
        const { manager } = ctx

        try {
            let id

            if (token) {
                const payload = Jwt.verify(
                    token,
                    this.config.tokensConfig.secretKey
                ) as JwtPayload

                id = payload.id
            } else {
                id = userId
            }

            if (!id) {
                return
            }

            const user: any = await manager.findOne(
                this.resources.user.data.pascalCaseName,
                {
                    id
                },
                {
                    populate: this.config.rolesAndPermissions
                        ? [this.getRolesAndPermissionsNames()]
                        : []
                }
            )

            if (this.config.rolesAndPermissions && user) {
                user[this.getPermissionUserKey()] = user[this.getRoleUserKey()]
                    ?.toJSON()
                    .reduce(
                        (acc: string[], role: UserRole) => [
                            ...acc,
                            ...(role as any)[this.getPermissionUserKey()].map(
                                (p: any) => p.slug
                            )
                        ],
                        []
                    )
            }

            ctx.user = user
        } catch (error) {}
    }

    private getRoleUserKey() {
        return this.resources.role.data.snakeCaseName
    }

    private getPermissionUserKey() {
        return this.resources.permission.data.snakeCaseNamePlural
    }

    public getAuthUserFromContext = async (ctx: ApiContext) => {
        const { req } = ctx

        const { headers } = req
        const [, token] = (headers['authorization'] || '').split('Bearer ')

        let userId = ctx.req.session.user?.id

        if (!token && !userId) return

        return this.populateContextFromToken(token, ctx, userId)
    }

    private disableTwoFactorAuth = async ({
        manager,
        body,
        user,
        userInputError
    }: ApiContext) => {
        if (user.two_factor_enabled) {
            throw userInputError(
                `You do not have two factor authentication enabled.`
            )
        }

        const Speakeasy = require('speakeasy')

        const verified = Speakeasy.totp.verify({
            encoding: 'base32',
            token: body.object ? body.object.token : body.token,
            secret: user.two_factor_secret
        })

        if (!verified) {
            throw userInputError(`Invalid two factor authentication code.`)
        }

        manager.assign(user, {
            two_factor_secret: null,
            two_factor_enabled: false
        })

        await manager.persistAndFlush(user)

        return user.toJSON()
    }

    private confirmEnableTwoFactorAuth = async ({
        user,
        body,
        manager,
        userInputError
    }: ApiContext) => {
        const Speakeasy = require('speakeasy')

        const payload = await validateAll(body.object ? body.object : body, {
            token: 'required|number'
        })

        if (!user.two_factor_secret) {
            throw userInputError(
                `You must enable two factor authentication first.`
            )
        }

        const verified = Speakeasy.totp.verify({
            encoding: 'base32',
            token: payload.token,
            secret: user.two_factor_secret
        })

        if (!verified) {
            throw userInputError(`Invalid two factor token.`)
        }

        manager.assign(user, {
            two_factor_enabled: true
        })

        await manager.persistAndFlush(user)

        return user.toJSON()
    }

    private enableTwoFactorAuth = async ({ user, manager }: ApiContext) => {
        const Qr = require('qrcode')
        const Speakeasy = require('speakeasy')

        const { base32, otpauth_url } = Speakeasy.generateSecret()

        manager.assign(user, {
            two_factor_secret: base32,
            two_factor_enabled: null
        })

        await manager.persistAndFlush(user!)

        return new Promise((resolve, reject) =>
            Qr.toDataURL(
                otpauth_url,
                (error: null | Error, dataURL: string) => {
                    if (error) {
                        reject({
                            status: 500,
                            message: `Error generating qr code.`,
                            error
                        })
                    }

                    return resolve({
                        dataURL,
                        user: user.toJSON()
                    })
                }
            )
        )
    }

    protected forgotPassword = async ({
        body,
        mailer,
        manager,
        userInputError
    }: ApiContext) => {
        const { email } = await validateAll(body.object ? body.object : body, {
            email: 'required|email'
        })

        const existingUser: any = await manager.findOne(
            this.resources.user.data.pascalCaseName,
            {
                email
            }
        )
        const existingPasswordReset = await manager.findOne(
            this.resources.passwordReset.data.pascalCaseName,
            {
                email
            }
        )

        if (!existingUser) {
            throw userInputError('Validation failed.', {
                errors: [
                    {
                        field: 'email',
                        message: 'Invalid email address.'
                    }
                ]
            })
        }

        const token = this.generateRandomToken()

        const expiresAt = Dayjs().add(1, 'hour').format('YYYY-MM-DD HH:mm:ss')

        if (existingPasswordReset) {
            // make sure it has not expired
            manager.assign(existingPasswordReset, {
                token,
                expires_at: expiresAt
            })

            manager.persist(existingPasswordReset)
        } else {
            manager.persist(
                manager.create(
                    this.resources.passwordReset.data.pascalCaseName,
                    {
                        email,
                        token,
                        expires_at: expiresAt
                    }
                )
            )
        }

        await manager.flush()

        mailer
            .to(email, existingUser.name)
            .sendRaw(`Some raw message to send with the token ${token}`)

        return true
    }

    protected resetPassword = async ({
        body,
        manager,
        userInputError
    }: ApiContext) => {
        const { token, password } = await validateAll(
            body.object ? body.object : body,
            {
                token: 'required|string',
                password: 'required|string|min:8'
            }
        )

        let existingPasswordReset: any = await manager.findOne(
            this.resources.passwordReset.data.pascalCaseName,
            {
                token
            }
        )

        if (!existingPasswordReset) {
            throw userInputError('Validation failed.', {
                errors: [
                    {
                        field: 'token',
                        message: 'Invalid reset token.'
                    }
                ]
            })
        }

        if (Dayjs(existingPasswordReset.expires_at).isBefore(Dayjs())) {
            throw userInputError('Validation failed.', {
                errors: [
                    {
                        field: 'token',
                        message: 'Invalid reset token.'
                    }
                ]
            })
        }

        let user: any = await manager.findOne(
            this.resources.user.data.pascalCaseName,
            {
                email: existingPasswordReset.email
            }
        )

        if (!user) {
            manager.removeAndFlush(existingPasswordReset)

            return false
        }

        manager.assign(user, {
            password
        })

        manager.persist(user)
        manager.remove(existingPasswordReset)

        await manager.flush()

        // TODO: Send an email to the user notifying them
        // that their password was reset.

        return true
    }

    protected validate = async (data: AuthData, registration = false) => {
        let rules: {
            [key: string]: string
        } = {
            email: 'required|email',
            password: 'required|min:8'
        }

        return await validateAll(data, rules, {
            'email.required': 'The email is required.',
            'password.required': 'The password is required.',
            'name.required': 'The name is required.'
        })
    }

    public async generateRefreshToken(
        ctx: GraphQLPluginContext,
        previousTokenExpiry?: string
    ): Promise<string> {
        const plainTextToken = this.generateRandomToken(64)

        // Expire all existing refresh tokens for this customer.
        await ctx.manager.nativeUpdate(
            this.resources.token.data.pascalCaseName,
            {
                [this.resources.user.data.snakeCaseName]: ctx.user.id
            } as any,
            {
                expires_at: Dayjs().subtract(1, 'second').format(),
                last_used_at: Dayjs().subtract(1, 'second').format()
            }
        )

        const entity = ctx.manager.create(
            this.resources.token.data.pascalCaseName,
            {
                token: plainTextToken,
                [this.resources.user.data.snakeCaseName]: ctx.user.id,
                type: 'REFRESH',
                expires_at: previousTokenExpiry
                    ? previousTokenExpiry
                    : Dayjs().add(
                          this.config.tokensConfig.refreshTokenExpiresIn,
                          'second'
                      )
            }
        )

        await ctx.manager.persistAndFlush(entity)

        return plainTextToken
    }

    private generateJwt(payload: DataPayload) {
        return Jwt.sign(payload, this.config.tokensConfig.secretKey, {
            expiresIn: this.config.tokensConfig.accessTokenExpiresIn
        })
    }

    public beforeOauthIdentityCreated(
        beforeOAuthIdentityCreated: HookFunction
    ) {
        this.config.beforeOAuthIdentityCreated = beforeOAuthIdentityCreated

        return this
    }

    public generateRandomToken(length = 32) {
        return (
            Randomstring.generate(length) +
            Uniqid() +
            Randomstring.generate(length)
        )
    }

    public social(provider: SupportedSocialProviders, config: GrantConfig) {
        this.config.providers[provider] = {
            ...config,
            callback: config.callback
                ? config.callback
                : `/${this.config.apiPath}/${provider}/callback`,

            scope:
                config.scope && config.scope.length > 0
                    ? config.scope
                    : defaultProviderScopes(provider)
        }

        return this
    }
}

export const auth = () => new Auth()
