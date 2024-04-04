
# Interact.sh Server CDK Construct

This construct implements an easy-to-use, cheap-to-run Interact.sh instance. It is a semi-highly available
implementation where only a single server is running at a time, but an AutoScaling Group is used to achieve high
availability: In case the instance is terminated, ASG spins up a new instance and continues where it was.

## Usage

Interact.sh requires changes at your domain registrar. The elastic IP address needs to be provisioned separately from the Interact.sh construct, to avoid changing the IP unnecessarily. Below is a code snippet for getting started with the construct.

```typescript
import { Stack, StackProps } from 'aws-cdk-lib';
import { CfnEIP, IpAddresses, KeyPair, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { InteractshInstance } from 'interactsh-instance';

const domains = 'example.com';
const token = `<your secure token - DO NOT USE THIS DEFAULT ${(Math.random() + 1).toString(36).substring(2)}>`;

export class MyStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // Import a public key into an SSH keypair
        const keyPair = new KeyPair(this, 'keypair', {
            publicKeyMaterial: '<your SSH public key>',
        });

        // Create an elastic IP address
        const eip = new CfnEIP(this, `eip`);

        // Create a VPC
        const vpc = new Vpc(this, 'vpc', {
            enableDnsHostnames: false,
            enableDnsSupport: true,
            ipAddresses: IpAddresses.cidr('<your cidr/mask>'),
            maxAzs: 1,
            natGateways: 0,
            subnetConfiguration: [{ subnetType: SubnetType.PUBLIC, name: 'public' }],
        });

        // Create the instance
        new InteractshInstance(this, 'interactsh-instance', {
            domains: domains,
            eip: eip,
            keyPair: keyPair,
            token: token,
            vpc: vpc,
        });
    }
}
````

## Remote access

Instance enables AWS SSM for remote management. SSH access can be utilized by adding following into `~/.ssh/config`:

```ini
# AWS Session Manager
host i-* mi-*
    ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p'"
```

And then by executing `ssh ec2-user@<interact.sh instance id>`.

## Supported protocols

Interact.sh supports several protocols for logging interactions. Following are enabled:

- `tcp:21/ftp`: Folder `/var/lib/interactsh-server/ftp` on the server is available via FTP.
- `tcp:25/smtp`
- `udp:53/dns` and `tcp:53/dns`
- `tcp:80/http`: Folder `/var/lib/interactsh-server/www` on the server is available via HTTP.
- `tcp:389/ldap`
- `tcp:443/https`: Folder `/var/lib/interactsh-server/www` on the server is available via HTTPS.
- `tcp:465/smtps` implicit TLS
- `tcp:587/smtps` STARTTLS

## Removal

The construct can be be removed like any other resources. It's good to note that the persistent storage disk is also
removed and a snapshot is left as a leftover. If needed, the contents of the disk can be restored by creating a new EBS
volume from the snapshot, and by attaching it to an another instance.
