import { RemovalPolicy, Size, Stack, Tags } from 'aws-cdk-lib';
import { AutoScalingGroup, IAutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import {
    AmazonLinuxCpuType,
    AmazonLinuxEdition,
    AmazonLinuxGeneration,
    AmazonLinuxImage,
    BlockDeviceVolume,
    CfnEIP,
    EbsDeviceVolumeType,
    IKeyPair,
    ILaunchTemplate,
    ISecurityGroup,
    IVolume,
    IVpc,
    InstanceType,
    LaunchTemplate,
    LaunchTemplateHttpTokens,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    UserData,
    Volume,
} from 'aws-cdk-lib/aws-ec2';
import {
    Effect,
    IInstanceProfile,
    IRole,
    InstanceProfile,
    ManagedPolicy,
    PolicyStatement,
    Role,
    ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface InteractshInstanceProps {
    domains: string | string[]; // Domain or list of domains to listen for
    eip: CfnEIP; // Elastic IP address the instance associates with itself
    image?: string; // Docker image, defaults to projectdiscovery/interactsh-server:latest
    keyPair: IKeyPair; // SSH keypair used to connect to the instance
    token: string; // Authentication token
    volumeSize?: number; // Size of persistent storage volume
    vpc: IVpc; // VPC in which to place the instance (public subnet in first availability zone is used)
}

interface UserDataProps {
    domains: string;
    eipAllocationId: string;
    image: string;
    region: string;
    token: string;
    volume: string;
}

const DefaultImage = 'projectdiscovery/interactsh-server:latest';
const DefaultVolumeSize = 10;
const createUserData = (props: UserDataProps) => `#!/bin/bash

set -e

# Acquire the instance id
token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 3600")
instance_id=$(curl -s -H "X-aws-ec2-metadata-token: \${token}" "http://169.254.169.254/latest/meta-data/instance-id")

# TODO: Should we force detach the volume if its attached already?

# Attach persistent storage volume
aws ec2 attach-volume --device xvdb --instance-id \${instance_id} --volume-id ${props.volume}

# Update packages
yum update
yum upgrade -y

# Install and enable Docker
yum install -y docker
systemctl enable docker
systemctl start docker

# Pull the image
docker pull "${props.image}"

# Wait for the volume attachment to finalize before moving on
aws ec2 wait volume-in-use --volume-ids ${props.volume}

# Create a filesystem on the volume (if one does not exist) and persist the mount and mount it
xfs_info /dev/xvdb > /dev/null || mkfs.xfs /dev/xvdb
echo "UUID=$(blkid -s UUID -o value /dev/xvdb) /var/lib/interactsh-server xfs defaults,noatime 1 2" >> /etc/fstab
mkdir -p /var/lib/interactsh-server
mount /var/lib/interactsh-server

# Start Interact.sh
mkdir -p /var/lib/interactsh-server/{data,www,ftp}
docker run --name interactsh-server --detach --restart always \
    -p 21:21/tcp -p 25:25/tcp -p 53:53/tcp -p 53:53/udp -p 80:80/tcp -p 389:389/tcp \
    -p 443:443/tcp -p 465:465/tcp -p 587:587/tcp \
    -v /var/lib/interactsh-server/data:/data \
    -v /var/lib/interactsh-server/www:/www \
    -v /var/lib/interactsh-server/ftp:/ftp \
    "${props.image}" \
    -domain ${props.domains} -token ${props.token} \
    -ldap -smb -ftp -wildcard \
    -disk -disk-path /data \
    -http-directory /www \
    -ftp-dir /ftp \
    -disable-version -disable-update-check

# We're ready to accept connections, grab the public IP address
aws ec2 associate-address \
    --instance-id="\${instance_id}" \
    --allocation-id="${props.eipAllocationId}" \
    --region="${props.region}"

`;

export class InteractshInstance extends Construct {
    constructor(scope: Construct, id: string, props: InteractshInstanceProps) {
        super(scope, id);

        // Create role and instance profile
        const role = new Role(this, `${id}-role`, {
            assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
            description: 'Role for Interact.sh instance to use.',
        });
        const instanceProfile = new InstanceProfile(this, `${id}-instance-profile`, {
            role: role,
        });

        // Select the first AZ and create a volume for persistent data in it
        const availabilityZone = props.vpc.availabilityZones[0];
        const volume = new Volume(this, `${id}-volume`, {
            availabilityZone: availabilityZone,
            encrypted: true,
            iops: 3000,
            removalPolicy: RemovalPolicy.SNAPSHOT,
            size: Size.gibibytes(props.volumeSize ? props.volumeSize : DefaultVolumeSize),
            throughput: 125,
            volumeType: EbsDeviceVolumeType.GP3,
        });
        Tags.of(volume).add('Name', 'Interactsh-persistent-volume');

        // Create the managed policy and assign it to the role
        this.createManagedPolicy(`${id}-role-policy`, role, props.eip, volume);

        // Create user data object
        const userData = UserData.custom(
            createUserData({
                domains: Array.isArray(props.domains) ? props.domains.join(',') : props.domains,
                eipAllocationId: props.eip.attrAllocationId,
                image: DefaultImage,
                region: Stack.of(this).region,
                token: props.token,
                volume: volume.volumeId,
            })
        );

        // Create a security group
        const securityGroup = this.createSecurityGroup(`${id}-sg`, props.vpc);

        // Create a launch template
        const launchTemplate = this.createLaunchTemplate(
            `${id}-launch-template`,
            userData,
            instanceProfile,
            securityGroup,
            props.keyPair
        );

        // And finally create the auto scaling group
        this.createAutoScalingGroup(`${id}-asg`, launchTemplate, props.vpc, availabilityZone);
    }

    private createSecurityGroup(id: string, vpc: IVpc): ISecurityGroup {
        const securityGroup = new SecurityGroup(this, id, {
            allowAllIpv6Outbound: true,
            allowAllOutbound: true,
            vpc: vpc,
        });

        const ports: { port: Port; description: string }[] = [
            { port: Port.tcp(21), description: 'Interact.sh server: Permit FTP TCP' },
            { port: Port.tcp(25), description: 'Interact.sh server: Permit SMTP TCP' },
            { port: Port.tcp(53), description: 'Interact.sh server: Permit DNS TCP' },
            { port: Port.tcp(80), description: 'Interact.sh server: Permit HTTP TCP' },
            { port: Port.tcp(389), description: 'Interact.sh server: Permit LDAP TCP' },
            { port: Port.tcp(443), description: 'Interact.sh server: Permit HTTPS TCP' },
            // { port: Port.tcp(445), description: 'Interact.sh server: Permit SMB TCP' },
            { port: Port.tcp(465), description: 'Interact.sh server: Permit SMTP AUTOTLS TCP' },
            { port: Port.tcp(587), description: 'Interact.sh server: Permit SMTPS TCP' },
            { port: Port.udp(53), description: 'Interact.sh server: Permit DNS UDP' },
        ];

        // Allow both IPv4 and IPv6
        ports.forEach(({ port, description }) => {
            securityGroup.addIngressRule(Peer.anyIpv4(), port, `${description} IPv4`);
            securityGroup.addIngressRule(Peer.anyIpv6(), port, `${description} IPv6`);
        });

        return securityGroup;
    }

    private createLaunchTemplate(
        id: string,
        userData: UserData,
        instanceProfile: IInstanceProfile,
        securityGroup: ISecurityGroup,
        keyPair: IKeyPair
    ): ILaunchTemplate {
        // Create an encrypted volume (deleted on termination) for the instance
        const volume = BlockDeviceVolume.ebs(10, {
            deleteOnTermination: true,
            encrypted: true,
            volumeType: EbsDeviceVolumeType.GP3,
        });

        const launchTemplate = new LaunchTemplate(this, id, {
            associatePublicIpAddress: true, // Temporary public ip address is needed so we can call AWS APIs
            blockDevices: [{ deviceName: '/dev/xvda', volume: volume }],
            detailedMonitoring: false,
            ebsOptimized: true,
            httpEndpoint: true,
            httpTokens: LaunchTemplateHttpTokens.REQUIRED,
            instanceProfile: instanceProfile,
            instanceType: new InstanceType('t4g.nano'),
            keyPair: keyPair,
            machineImage: new AmazonLinuxImage({
                cachedInContext: false,
                cpuType: AmazonLinuxCpuType.ARM_64,
                edition: AmazonLinuxEdition.STANDARD,
                generation: AmazonLinuxGeneration.AMAZON_LINUX_2023,
            }),
            requireImdsv2: true,
            userData: userData,
            securityGroup: securityGroup,
        });

        return launchTemplate;
    }

    private createAutoScalingGroup(
        id: string,
        launchTemplate: ILaunchTemplate,
        vpc: IVpc,
        availabilityZone: string
    ): IAutoScalingGroup {
        const autoScalingGroup = new AutoScalingGroup(this, id, {
            launchTemplate: launchTemplate,
            maxCapacity: 1,
            minCapacity: 1,
            vpc: vpc,
            vpcSubnets: { availabilityZones: [availabilityZone] },
        });

        // Apply a tag to the instances so we can use it as a condition in IAM policies
        Tags.of(autoScalingGroup).add('Interactsh', 'server', { applyToLaunchedInstances: true });

        return autoScalingGroup;
    }

    private createManagedPolicy(id: string, role: IRole, eip: CfnEIP, volume: IVolume): void {
        const account = Stack.of(this).account;
        const partition = Stack.of(this).partition;
        const region = Stack.of(this).region;

        const policy = new ManagedPolicy(this, id, {
            statements: [
                new PolicyStatement({
                    actions: ['ec2:AssociateAddress'],
                    effect: Effect.ALLOW,
                    resources: [`arn:${partition}:ec2:${region}:${account}:elastic-ip/${eip.attrAllocationId}`],
                }),
                new PolicyStatement({
                    actions: ['ec2:AttachVolume'],
                    effect: Effect.ALLOW,
                    resources: [`arn:${partition}:ec2:${region}:${account}:volume/${volume.volumeId}`],
                }),
                new PolicyStatement({
                    actions: ['ec2:DescribeVolumes'],
                    effect: Effect.ALLOW,
                    resources: ['*'],
                }),

                new PolicyStatement({
                    actions: ['ec2:AssociateAddress', 'ec2:AttachVolume', 'ec2:DetachVolume'],
                    conditions: {
                        StringEquals: { 'aws:ResourceTag/Interactsh': 'server' },
                    },
                    effect: Effect.ALLOW,
                    resources: [`arn:${partition}:ec2:${region}:${account}:instance/*`],
                }),
            ],
        });

        role.addManagedPolicy(policy);
        role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    }
}
