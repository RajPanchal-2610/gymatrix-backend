import nodemailer from 'nodemailer';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

class EmailService {
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.initializeTransporter();
  }

  private initializeTransporter() {
    const host = process.env.EMAIL_HOST;
    const port = parseInt(process.env.EMAIL_PORT || '587');
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!host || !user || !pass) {
      console.warn('⚠️  Email configuration is not set. Email notifications will be disabled.');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465, false for other ports
      auth: {
        user,
        pass,
      },
    });

    console.log('✅ Email service initialized successfully');
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!this.transporter) {
      console.error('❌ Email transporter not initialized');
      return false;
    }

    try {
      const info = await this.transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      console.log(`✅ Email sent to ${options.to} (${info.messageId})`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send email to ${options.to}:`, error);
      return false;
    }
  }

  async sendTrialExpiryReminder(
    to: string,
    userName: string,
    planName: string,
    expiryDate: string
  ): Promise<boolean> {
    const subject = `⚠️ Your ${planName} Trial Expires in 3 Days!`;
    const html = this.getTrialExpiryEmailTemplate(userName, planName, expiryDate);
    const text = `Hi ${userName},\n\nYour ${planName} trial will expire in 3 days on ${expiryDate}.\n\nUpgrade now to continue enjoying all features without interruption.\n\nBest regards,\nFitFlow Team`;

    return this.sendEmail({ to, subject, html, text });
  }

  async sendSubscriptionRenewalReminder(
    to: string,
    userName: string,
    planName: string,
    expiryDate: string
  ): Promise<boolean> {
    const subject = `🔔 Your ${planName} Subscription Ends in 3 Days`;
    const html = this.getSubscriptionRenewalEmailTemplate(userName, planName, expiryDate);
    const text = `Hi ${userName},\n\nYour ${planName} subscription will end in 3 days on ${expiryDate}.\n\nRenew your subscription to continue enjoying all features without interruption.\n\nBest regards,\nFitFlow Team`;

    return this.sendEmail({ to, subject, html, text });
  }

  private getTrialExpiryEmailTemplate(
    userName: string,
    planName: string,
    expiryDate: string
  ): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Trial Expiry Reminder</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8fafc;">
          <tr>
            <td align="center" style="padding: 40px 20px;">
              <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.1);">
                
                <!-- Header -->
                <tr>
                  <td style="background: linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%); padding: 40px 30px; text-align: center;">
                    <table role="presentation" style="margin: 0 auto 15px auto;">
                      <tr>
                        <td style="background: linear-gradient(135deg, #2563eb 0%, #0ea5e9 50%, #6366f1 100%); border-radius: 12px; padding: 12px; text-align: center;">
                          <span style="color: #ffffff; font-size: 24px; font-weight: 700;">🏋️</span>
                        </td>
                      </tr>
                    </table>
                    <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 800; letter-spacing: -0.5px;">Fit<span style="color: #e0f2fe;">Flow</span></h1>
                    <p style="margin: 8px 0 0 0; color: #e0f2fe; font-size: 14px; font-weight: 500;">Gym Management Platform</p>
                  </td>
                </tr>

                <!-- Content -->
                <tr>
                  <td style="padding: 40px 30px;">
                    <h2 style="margin: 0 0 20px 0; color: #0f172a; font-size: 24px; font-weight: 700;">
                      ⏰ Your Trial Expires in 3 Days!
                    </h2>
                    
                    <p style="margin: 0 0 15px 0; color: #475569; font-size: 16px; line-height: 1.6;">
                      Hi <strong style="color: #0f172a;">${userName}</strong>,
                    </p>
                    
                    <p style="margin: 0 0 20px 0; color: #475569; font-size: 16px; line-height: 1.6;">
                      This is a friendly reminder that your <strong style="color: #0f172a;">${planName}</strong> trial will expire in <strong style="color: #2563eb;">3 days</strong> on <strong style="color: #0f172a;">${expiryDate}</strong>.
                    </p>

                    <!-- Alert Box -->
                    <table role="presentation" style="width: 100%; border-collapse: collapse; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-left: 4px solid #f59e0b; border-radius: 8px; margin: 25px 0;">
                      <tr>
                        <td style="padding: 16px 20px;">
                          <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6;">
                            <strong>⚠️ Don't lose access!</strong> Upgrade to a paid plan to continue enjoying all features without interruption.
                          </p>
                        </td>
                      </tr>
                    </table>

                    <!-- CTA Button -->
                    <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 30px 0;">
                      <tr>
                        <td align="center">
                          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/upgrade" 
                             style="display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: #ffffff; text-decoration: none; border-radius: 12px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 15px rgba(37, 99, 235, 0.2);">
                            Upgrade Now →
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p style="margin: 20px 0 0 0; color: #64748b; font-size: 14px; line-height: 1.6;">
                      If you have any questions or need assistance, our support team is here to help!
                    </p>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%); padding: 30px; text-align: center; border-top: 1px solid rgba(0,0,0,0.05);">
                    <p style="margin: 0 0 10px 0; color: #64748b; font-size: 12px; line-height: 1.6;">
                      This is an automated message from FitFlow Gym Management Platform.
                    </p>
                    <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                      © ${new Date().getFullYear()} FitFlow. All rights reserved.
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
  }

  private getSubscriptionRenewalEmailTemplate(
    userName: string,
    planName: string,
    expiryDate: string
  ): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Subscription Expiry Reminder</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc;">
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8fafc;">
          <tr>
            <td align="center" style="padding: 40px 20px;">
              <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.1);">
                
                <!-- Header -->
                <tr>
                  <td style="background: linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%); padding: 40px 30px; text-align: center;">
                    <table role="presentation" style="margin: 0 auto 15px auto;">
                      <tr>
                        <td style="background: linear-gradient(135deg, #2563eb 0%, #0ea5e9 50%, #6366f1 100%); border-radius: 12px; padding: 12px; text-align: center;">
                          <span style="color: #ffffff; font-size: 24px; font-weight: 700;">🏋️</span>
                        </td>
                      </tr>
                    </table>
                    <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 800; letter-spacing: -0.5px;">Fit<span style="color: #e0f2fe;">Flow</span></h1>
                    <p style="margin: 8px 0 0 0; color: #e0f2fe; font-size: 14px; font-weight: 500;">Gym Management Platform</p>
                  </td>
                </tr>

                <!-- Content -->
                <tr>
                  <td style="padding: 40px 30px;">
                    <h2 style="margin: 0 0 20px 0; color: #0f172a; font-size: 24px; font-weight: 700;">
                      ⏰ Your Subscription Ends in 3 Days!
                    </h2>
                    
                    <p style="margin: 0 0 15px 0; color: #475569; font-size: 16px; line-height: 1.6;">
                      Hi <strong style="color: #0f172a;">${userName}</strong>,
                    </p>
                    
                    <p style="margin: 0 0 20px 0; color: #475569; font-size: 16px; line-height: 1.6;">
                      Your <strong style="color: #0f172a;">${planName}</strong> subscription will end in <strong style="color: #2563eb;">3 days</strong> on <strong style="color: #0f172a;">${expiryDate}</strong>.
                    </p>

                    <!-- Info Box -->
                    <table role="presentation" style="width: 100%; border-collapse: collapse; background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%); border-left: 4px solid #3b82f6; border-radius: 8px; margin: 25px 0;">
                      <tr>
                        <td style="padding: 16px 20px;">
                          <p style="margin: 0; color: #1e40af; font-size: 14px; line-height: 1.6;">
                            <strong>💡 Keep the momentum going!</strong> Renew now to ensure uninterrupted access to all your gym management features.
                          </p>
                        </td>
                      </tr>
                    </table>

                    <!-- CTA Button -->
                    <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 30px 0;">
                      <tr>
                        <td align="center">
                          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard/billing"
                             style="display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: #ffffff; text-decoration: none; border-radius: 12px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 15px rgba(37, 99, 235, 0.2);">
                            Renew Now
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p style="margin: 20px 0 0 0; color: #64748b; font-size: 14px; line-height: 1.6;">
                      Renew your subscription to continue enjoying all features without interruption. If you have any questions, our support team is here to help!
                    </p>
                  </td>
                </tr>

                <!-- Footer -->
                <tr>
                  <td style="background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%); padding: 30px; text-align: center; border-top: 1px solid rgba(0,0,0,0.05);">
                    <p style="margin: 0 0 10px 0; color: #64748b; font-size: 12px; line-height: 1.6;">
                      This is an automated message from FitFlow Gym Management Platform.
                    </p>
                    <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                      © ${new Date().getFullYear()} FitFlow. All rights reserved.
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      console.error('❌ Email transporter not initialized');
      return false;
    }

    try {
      await this.transporter.verify();
      console.log('✅ Email server is ready to send messages');
      return true;
    } catch (error) {
      console.error('❌ Email server connection failed:', error);
      return false;
    }
  }
}

export const emailService = new EmailService();
